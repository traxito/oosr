import {
  buildEvent,
  signEvent,
  toPublicJwk,
  type CapabilityManifest,
  type ObjectDescription,
  type ObjectState,
  type OosrEvent,
  type PrivateJwk,
  type SkillPackage,
  type SkillRef,
} from '@oosr/core';

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

export interface TaskView {
  skill: string;
  task: string;
  eligible: boolean;
  missing: string[];
  exceeded: string[];
  physical: boolean;
  needs_approval: boolean;
  in_season: boolean;
  trigger: boolean | null;
  preconditions: boolean | null;
  sensors: string[];
  lease: { robot: string; expires_at: string } | null;
}

export interface Approval {
  id: string;
  status: 'pending' | 'granted' | 'denied' | 'consumed';
}

export interface Enrolment {
  id: string;
  status: 'pending' | 'confirmed' | 'rejected';
  object?: string;
}

export interface RobotClientOptions {
  hub: string;
  capability: CapabilityManifest;
  key: PrivateJwk;
  token?: string;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal robot-side SDK for the hub API v0. */
export class RobotClient {
  readonly hub: string;
  readonly capability: CapabilityManifest;
  token: string | undefined;
  private readonly key: PrivateJwk;
  private readonly fetchImpl: typeof fetch;
  private lamport = 0;

  constructor(opts: RobotClientOptions) {
    this.hub = opts.hub.replace(/\/$/, '');
    this.capability = opts.capability;
    this.key = opts.key;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get robot(): string {
    return this.capability.robot;
  }

  get kid(): string {
    return `${this.robot}#att`;
  }

  /** OAuth 2.0 Device Authorization Grant (RFC 8628). */
  async pair(onCode: (userCode: string, verificationUri: string) => void, opts: { timeoutMs?: number } = {}): Promise<string> {
    const publicJwk = toPublicJwk(this.key);
    const start = await this.request<{ device_code: string; user_code: string; verification_uri_complete: string; interval: number }>(
      'POST',
      '/v0/pair/device',
      { capability: this.capability, public_jwk: publicJwk },
      false,
    );
    onCode(start.user_code, start.verification_uri_complete);
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    while (Date.now() < deadline) {
      try {
        const res = await this.request<{ access_token: string }>('POST', '/v0/pair/token', { device_code: start.device_code }, false);
        this.token = res.access_token;
        return res.access_token;
      } catch (e) {
        if (!(e instanceof ClientError) || e.code !== 'authorization_pending') throw e;
      }
      await sleep(start.interval * 1000);
    }
    throw new Error('pairing timed out');
  }

  async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.hub}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string; lamport?: number };
    if (!res.ok) throw new ClientError(res.status, json.error ?? 'error', json.message ?? res.statusText);
    if (typeof json.lamport === 'number') this.lamport = Math.max(this.lamport, json.lamport);
    return json as T;
  }

  info() {
    return this.request<{ hub: string; scope_id: string; lamport: number }>('GET', '/v0/hub');
  }

  resolve(scope: string, tag: number, family = 'tag36h11') {
    return this.request<{ object: string }>('GET', `/v0/resolve?scope=${encodeURIComponent(scope)}&family=${family}&tag=${tag}`);
  }

  objects() {
    return this.request<(ObjectDescription & { state: ObjectState })[]>('GET', '/v0/objects');
  }

  object(urn: string) {
    return this.request<ObjectDescription>('GET', `/v0/objects/${encodeURIComponent(urn)}`);
  }

  state(urn: string) {
    return this.request<ObjectState>('GET', `/v0/objects/${encodeURIComponent(urn)}/state`);
  }

  tasks(urn: string) {
    return this.request<TaskView[]>('GET', `/v0/objects/${encodeURIComponent(urn)}/tasks`);
  }

  skill(ref: string) {
    const at = ref.lastIndexOf('@');
    return this.request<SkillPackage>('GET', `/v0/skills/${encodeURIComponent(ref.slice(0, at))}@${ref.slice(at + 1)}`);
  }

  publishCapability() {
    return this.request('PUT', '/v0/robots/me/capability', this.capability);
  }

  proposeEnrolment(body: {
    tag_family?: string;
    tag_id: number;
    tag_size_mm: number;
    proposed_type: string;
    confidence?: number;
    zone?: string;
    skills?: SkillRef[];
    gs1_digital_link?: string;
  }) {
    return this.request<Enrolment>('POST', '/v0/enrolments', { tag_family: 'tag36h11', ...body });
  }

  enrolment(id: string) {
    return this.request<Enrolment>('GET', `/v0/enrolments/${id}`);
  }

  requestApproval(object: string, skill: string, task: string) {
    return this.request<Approval>('POST', '/v0/approvals', { object, skill, task });
  }

  approval(id: string) {
    return this.request<Approval>('GET', `/v0/approvals/${id}`);
  }

  /** Builds, signs and appends an event. Lamport = max(seen) + 1. */
  async emit(type: string, subject: string, data: Record<string, unknown>, skill?: string): Promise<OosrEvent> {
    const ev = await this.sign(type, subject, data, skill);
    await this.append(ev);
    return ev;
  }

  async sign(type: string, subject: string, data: Record<string, unknown>, skill?: string): Promise<OosrEvent> {
    this.lamport += 1;
    return signEvent(buildEvent({ source: this.robot, type, subject, data, lamport: this.lamport, ...(skill ? { skill } : {}) }), this.key, this.kid);
  }

  append(ev: OosrEvent) {
    return this.request<{ id: string; duplicate: boolean; lamport: number }>('POST', '/v0/events', ev);
  }

  /** Raise the local clock to the hub's before writing after a period offline. */
  async syncClock(): Promise<void> {
    const { lamport } = await this.info();
    this.lamport = Math.max(this.lamport, lamport);
  }
}
