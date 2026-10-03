import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  generateKeyPair,
  issueDeviceCert,
  signSkill,
  toPublicJwk,
  type CapabilityManifest,
  type HomePolicy,
  type PrivateJwk,
  type SkillManifest,
  type SkillPackage,
} from '@oosr/core';
import { Hub, createHubServer } from '@oosr/hub';
import { RobotClient } from '@oosr/sim';

/**
 * Set OOSR_HUB_URL and OOSR_OWNER_TOKEN to run the suite against any hub implementation
 * (`npm run conformance -- --url ... --token ...`). Without them, a fresh reference hub is
 * started per test. Everything after boot goes through the HTTP API.
 */
export const EXTERNAL = Boolean(process.env.OOSR_HUB_URL);

export const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);
export const ficusManifest = (): SkillManifest => JSON.parse(readFileSync(fixture('ficus-manifest.json'), 'utf8'));
export const KNOWLEDGE = readFileSync(fixture('ficus-knowledge.md'));

export const VIVERO = 'did:web:vivero-x.es';
export const VIVERO_KID = `${VIVERO}#key-1`;
export const ACME = 'did:web:acme.example';
export const ACME_KID = `${ACME}#key-1`;

export const acmeCapability = (): CapabilityManifest => JSON.parse(readFileSync(fixture('acme-capability.json'), 'utf8'));

export const humanoidCapability = (): CapabilityManifest => ({
  oosr: '0.1',
  robot: 'urn:oosr:robot:otherco:hx-0042',
  model: 'otherco/humanoid-1',
  primitives: ['navigate_to', 'inspect', 'measure:soil_moisture', 'dispense:water', 'grasp', 'place', 'cut', 'notify_human'],
  limits: { payload_kg: 5, dispense_max_ml: 800 },
});

export const vacuumCapability = (): CapabilityManifest => ({
  oosr: '0.1',
  robot: 'urn:oosr:robot:cleanco:v-77',
  model: 'cleanco/vacuum-3',
  primitives: ['navigate_to', 'inspect'],
});

export interface Tag {
  family: string;
  id: number;
}

export interface PairOptions {
  write?: string[];
  zones?: string[];
  key?: PrivateJwk;
  deviceCert?: string;
}

export interface Env {
  url: string;
  scope: string;
  /** Reference hub only (undefined when EXTERNAL). */
  hub?: Hub;
  dir?: string;
  publisherKey: PrivateJwk;
  manufacturerKey: PrivateJwk;
  owner<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  sign(manifest: SkillManifest, files?: Record<string, Uint8Array>): Promise<SkillPackage>;
  /** Capability with a robot URN unique to this run (external hubs keep state between runs). */
  robot(cap: CapabilityManifest): CapabilityManifest;
  /** A tag unique to this run. In local mode, tag36h11 #n as in the RFC. */
  tag(n: number): Tag;
  pairRobot(cap: CapabilityManifest, opts?: PairOptions): Promise<RobotClient>;
  deviceCert(cap: CapabilityManifest, key: PrivateJwk, extra?: { exp?: number; model?: string; iss?: string }): Promise<string>;
  enrol(robot: RobotClient, tag: Tag, body: Record<string, unknown>, proposedType?: string): Promise<string>;
  updatePolicy(change: (p: HomePolicy) => HomePolicy): Promise<void>;
  close(): Promise<void>;
}

export async function startEnv(): Promise<Env> {
  let url: string;
  let ownerToken: string;
  let hub: Hub | undefined;
  let dir: string | undefined;
  let server: Server | undefined;

  if (EXTERNAL) {
    url = process.env.OOSR_HUB_URL!.replace(/\/$/, '');
    ownerToken = process.env.OOSR_OWNER_TOKEN ?? '';
  } else {
    dir = mkdtempSync(join(tmpdir(), 'oosr-hub-'));
    const init = await Hub.init(dir, { scopeId: 'hub-7f3a' });
    hub = init.hub;
    ownerToken = init.ownerToken;
    server = createHubServer(hub);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const owner = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${ownerToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const must = async (method: string, path: string, body?: unknown) => {
    const r = await owner(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  const { scope_id: scope } = await must('GET', '/v0/hub');
  const original: HomePolicy = await must('GET', '/v0/policy');
  const updatePolicy = async (change: (p: HomePolicy) => HomePolicy) => {
    await must('PUT', '/v0/policy', change(await must('GET', '/v0/policy')));
  };

  // Test publisher and manufacturer: trusted and pinned through the API (local-first, no network).
  const { privateJwk: publisherKey } = await generateKeyPair(VIVERO_KID);
  const { privateJwk: manufacturerKey } = await generateKeyPair(ACME_KID);
  await must('POST', '/v0/trust/keys', { kid: VIVERO_KID, jwk: toPublicJwk(publisherKey) });
  await must('POST', '/v0/trust/keys', { kid: ACME_KID, jwk: toPublicJwk(manufacturerKey) });
  await updatePolicy((p) => ({
    ...p,
    trusted_publishers: [...new Set([...p.trusted_publishers, VIVERO])],
    trusted_manufacturers: { ...(p.trusted_manufacturers ?? {}), acme: ACME },
  }));

  const run = randomBytes(3).toString('hex');
  const usedTags = new Set<number>();
  const tag = (n: number): Tag => {
    if (!EXTERNAL) return { family: 'tag36h11', id: n };
    let id: number;
    do id = randomBytes(2).readUInt16BE() % 48714;
    while (usedTags.has(id));
    usedTags.add(id);
    return { family: 'tagStandard52h13', id };
  };
  const robot = (cap: CapabilityManifest): CapabilityManifest => (EXTERNAL ? { ...cap, robot: `${cap.robot}-${run}` } : cap);

  const sign = async (manifest: SkillManifest, files: Record<string, Uint8Array> = { 'knowledge.md': KNOWLEDGE }) => {
    const signed = await signSkill(manifest, files, publisherKey, VIVERO_KID);
    return { manifest: signed, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
  };

  const deviceCert = async (cap: CapabilityManifest, key: PrivateJwk, extra: { exp?: number; model?: string; iss?: string } = {}) =>
    issueDeviceCert(
      { iss: extra.iss ?? ACME, sub: cap.robot, model: extra.model ?? cap.model, cnf: { jwk: toPublicJwk(key) }, key_storage: 'tpm', ...(extra.exp ? { exp: extra.exp } : {}) },
      manufacturerKey,
      ACME_KID,
    );

  const pairRobot = async (cap: CapabilityManifest, opts: PairOptions = {}) => {
    const key = opts.key ?? (await generateKeyPair()).privateJwk;
    const client = new RobotClient({ hub: url, capability: robot(cap), key });
    await client.pair(
      async (userCode) => {
        await must('POST', '/v0/pair/approve', { user_code: userCode, ...(opts.write ? { write: opts.write } : {}), ...(opts.zones ? { zones: opts.zones } : {}) });
      },
      opts.deviceCert ? { deviceCert: opts.deviceCert } : {},
    );
    await client.syncClock();
    return client;
  };

  const enrol = async (client: RobotClient, t: Tag, body: Record<string, unknown>, proposedType = 'plant/ficus-lyrata') => {
    const propose = () => client.proposeEnrolment({ tag_family: t.family, tag_id: t.id, tag_size_mm: 30, proposed_type: proposedType, confidence: 0.82 });
    let e;
    for (let attempt = 0; ; attempt++) {
      try {
        e = await propose();
        break;
      } catch (err) {
        // External hubs keep tags bound by earlier runs: draw another one.
        if (!EXTERNAL || attempt > 5 || (err as { code?: string }).code !== 'already_bound') throw err;
        t.id = tag(0).id;
      }
    }
    const confirmed = await must('POST', `/v0/enrolments/${e.id}/confirm`, body);
    await client.syncClock();
    return confirmed.object.id as string;
  };

  return {
    url,
    scope,
    ...(hub ? { hub } : {}),
    ...(dir ? { dir } : {}),
    publisherKey,
    manufacturerKey,
    owner,
    sign,
    robot,
    tag,
    pairRobot,
    deviceCert,
    enrol,
    updatePolicy,
    close: async () => {
      // Restore the owner's policy (trust lists, quiet hours...), keeping scopes of robots paired meanwhile.
      const current: HomePolicy = await must('GET', '/v0/policy');
      await owner('PUT', '/v0/policy', { ...original, ...(current.robots ? { robots: current.robots } : {}) });
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    },
  };
}
