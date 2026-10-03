import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRobot } from './audit.js';
import { Hub, HubError, type Principal } from './hub.js';

type Auth = 'public' | 'any' | 'owner' | 'robot';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  query: URLSearchParams;
  body: any;
  principal: Principal | undefined;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  auth: Auth;
  handler: Handler;
}

export interface ServerOptions {
  /** Directory of the human app, served at /app/. */
  appDir?: string;
  maxBodyBytes?: number;
}

const DEFAULT_APP_DIR = fileURLToPath(new URL('../../../apps/app/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function routes(hub: Hub): Route[] {
  const r = (method: string, path: string, auth: Auth, handler: Handler): Route => ({
    method,
    pattern: new RegExp(`^${path}$`),
    auth,
    handler,
  });
  const P = '([^/]+)';

  return [
    r('GET', '/\\.well-known/oosr', 'public', () => hub.info()),
    r('GET', '/v0/hub', 'any', () => hub.info()),
    r('GET', '/v0/keys', 'any', () => hub.keys()),

    // Spec 1-4: identity, description, state, events
    r('GET', '/v0/resolve', 'any', ({ query }) => {
      const tag = query.get('tag');
      if (tag === null || !/^\d+$/.test(tag)) throw new HubError(422, 'invalid_tag', 'tag must be a non-negative integer');
      return hub.resolve(query.get('scope') ?? '', query.get('family') ?? 'tag36h11', Number(tag));
    }),
    r('GET', '/v0/objects', 'any', () => hub.listObjects()),
    r('GET', `/v0/objects/${P}`, 'any', ({ params }) => hub.getObject(params[0]!)),
    r('PATCH', `/v0/objects/${P}`, 'owner', ({ params, body }) => hub.updateObject(params[0]!, body ?? {})),
    r('GET', `/v0/objects/${P}/state`, 'any', ({ params }) => hub.getState(params[0]!)),
    r('GET', `/v0/objects/${P}/events`, 'any', ({ params, query }) => hub.getEvents(params[0]!, query.get('since') ?? undefined)),
    r('GET', `/v0/objects/${P}/tasks`, 'any', ({ params, query, principal }) => hub.tasksFor(params[0]!, principal!, query.get('robot') ?? undefined)),
    r('POST', `/v0/objects/${P}/alerts/${P}/ack`, 'owner', async ({ params }) => (await hub.ackAlert(params[0]!, params[1]!), { ok: true })),
    r('GET', '/v0/events', 'owner', ({ query }) => hub.allEvents(Number(query.get('since') ?? 0))),
    r('POST', '/v0/events', 'robot', async ({ principal, body, res }) => {
      const { event, duplicate } = await hub.appendRobotEvent(principal!, body);
      res.statusCode = duplicate ? 200 : 201;
      return { id: event.id, duplicate, lamport: hub.info().lamport };
    }),

    // Spec 3: skills
    r('GET', '/v0/skills', 'any', () => hub.listSkills()),
    r('POST', '/v0/skills', 'owner', ({ body, res }) => ((res.statusCode = 201), hub.installSkill(body))),
    r('POST', '/v0/skills/fetch', 'owner', ({ body, res }) => ((res.statusCode = 201), hub.fetchSkill(body?.ref, body?.version))),
    r('GET', '/v0/skills/(.+)@([0-9.]+)', 'any', ({ params }) => hub.getSkill(params[0]!, params[1]!)),
    r('DELETE', '/v0/skills/(.+)@([0-9.]+)', 'owner', ({ params }) => (hub.removeSkill(params[0]!, params[1]!), { ok: true })),
    r('GET', '/v0/trust/keys', 'owner', () => hub.pinnedKeys()),
    r('POST', '/v0/trust/keys', 'owner', ({ body }) => (hub.pinKey(body?.kid, body?.jwk), { ok: true })),

    // Spec 5: pairing (RFC 8628), robots, policy
    r('POST', '/v0/pair/device', 'public', async ({ body, req }) => {
      const out = await hub.startPairing(body);
      const base = `http://${req.headers.host}`;
      return { ...out, verification_uri: `${base}/app/#/pair`, verification_uri_complete: `${base}/app/#/pair/${out.user_code}` };
    }),
    r('POST', '/v0/pair/token', 'public', ({ body }) => hub.pollPairing(body?.device_code)),
    r('GET', '/v0/pair/requests', 'owner', () => hub.listPairing()),
    r('POST', '/v0/pair/approve', 'owner', ({ body }) => {
      const { token_sha256: _t, ...robot } = hub.approvePairing(body?.user_code, { write: body?.write, zones: body?.zones });
      return robot;
    }),
    r('POST', '/v0/pair/deny', 'owner', ({ body }) => (hub.denyPairing(body?.user_code), { ok: true })),
    r('GET', '/v0/robots', 'owner', () => hub.listRobots()),
    r('PUT', '/v0/robots/me/capability', 'robot', ({ principal, body }) => (hub.updateCapability(principal!, body), { ok: true })),
    r('GET', `/v0/robots/${P}/audit`, 'owner', ({ params }) => auditRobot(hub, params[0]!)),
    r('GET', '/v0/rejections', 'owner', ({ query }) => hub.listRejections(query.get('robot') ?? undefined)),
    r('DELETE', `/v0/robots/${P}`, 'owner', ({ params }) => (hub.revokeRobot(params[0]!), { ok: true })),
    r('GET', '/v0/policy', 'owner', () => hub.getPolicy()),
    r('PUT', '/v0/policy', 'owner', ({ body }) => hub.setPolicy(body)),

    // Enrolment, bindings, approvals
    r('POST', '/v0/enrolments', 'robot', ({ principal, body, res }) => ((res.statusCode = 202), hub.proposeEnrolment(principal!, body))),
    r('GET', '/v0/enrolments', 'owner', ({ query }) => hub.listEnrolments(query.get('status') ?? undefined)),
    r('GET', `/v0/enrolments/${P}`, 'any', ({ params }) => hub.getEnrolment(params[0]!)),
    r('POST', `/v0/enrolments/${P}/confirm`, 'owner', ({ params, body }) => hub.confirmEnrolment(params[0]!, body ?? {})),
    r('POST', `/v0/enrolments/${P}/reject`, 'owner', ({ params }) => (hub.rejectEnrolment(params[0]!), { ok: true })),
    r('POST', '/v0/bindings/revoke', 'owner', async ({ body }) => (await hub.revokeBinding(body?.tag_family ?? 'tag36h11', body?.tag_id), { ok: true })),
    r('POST', '/v0/approvals', 'robot', ({ principal, body, res }) => ((res.statusCode = 202), hub.requestApproval(principal!, body))),
    r('GET', '/v0/approvals', 'owner', ({ query }) => hub.listApprovals(query.get('status') ?? undefined)),
    r('GET', `/v0/approvals/${P}`, 'any', ({ params }) => hub.getApproval(params[0]!)),
    r('POST', `/v0/approvals/${P}/grant`, 'owner', ({ params }) => hub.decideApproval(params[0]!, true)),
    r('POST', `/v0/approvals/${P}/deny`, 'owner', ({ params }) => hub.decideApproval(params[0]!, false)),
  ];
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<any> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HubError(413, 'too_large', `body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HubError(400, 'invalid_json', 'body is not valid JSON');
  }
}

function bearer(req: IncomingMessage, query: URLSearchParams): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  // EventSource cannot set headers; the stream endpoint accepts ?token=.
  return query.get('token') ?? undefined;
}

function serveStatic(appDir: string, urlPath: string, res: ServerResponse): boolean {
  const root = resolve(appDir);
  const rel = normalize(decodeURIComponent(urlPath.replace(/^\/app\/?/, ''))) || 'index.html';
  let file = resolve(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return false;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return false;
  res.statusCode = 200;
  res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
  res.setHeader('cache-control', 'no-cache');
  createReadStream(file).pipe(res);
  return true;
}

function stream(hub: Hub, principal: Principal, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify(hub.info())}\n\n`);
  const unsubscribe = hub.subscribe((m) => {
    // Robots only see the log; the inbox is the owner's.
    if (m.kind === 'inbox' && principal.kind !== 'owner') return;
    res.write(`event: ${m.kind}\ndata: ${JSON.stringify(m.kind === 'event' ? m.event : m)}\n\n`);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

export function createHubServer(hub: Hub, opts: ServerOptions = {}): Server {
  const table = routes(hub);
  const appDir = opts.appDir ?? DEFAULT_APP_DIR;
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
        res.writeHead(302, { location: '/app/' }).end();
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/app/')) {
        if (!serveStatic(appDir, url.pathname, res)) send(res, 404, { error: 'not_found', message: url.pathname });
        return;
      }
      const principal = hub.authenticate(bearer(req, url.searchParams));
      if (req.method === 'GET' && url.pathname === '/v0/stream') {
        if (!principal) throw new HubError(401, 'unauthorized', 'missing or invalid token');
        stream(hub, principal, req, res);
        return;
      }

      let matchedPath = false;
      for (const route of table) {
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        matchedPath = true;
        if (route.method !== req.method) continue;
        if (route.auth !== 'public') {
          if (!principal) throw new HubError(401, 'unauthorized', 'missing or invalid token');
          if (route.auth === 'owner' && principal.kind !== 'owner') throw new HubError(403, 'owner_only', 'requires the owner token');
          if (route.auth === 'robot' && principal.kind !== 'robot') throw new HubError(403, 'robots_only', 'requires a robot token');
        }
        const body = await readBody(req, maxBody);
        const params = m.slice(1).map((p) => decodeURIComponent(p));
        const result = await route.handler({ req, res, params, query: url.searchParams, body, principal });
        send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, result ?? { ok: true });
        return;
      }
      throw matchedPath ? new HubError(405, 'method_not_allowed', `${req.method} ${url.pathname}`) : new HubError(404, 'not_found', url.pathname);
    } catch (e) {
      if (e instanceof HubError) send(res, e.status, { error: e.code, message: e.message });
      else {
        console.error(e);
        send(res, 500, { error: 'internal', message: 'internal error' });
      }
    }
  });
}
