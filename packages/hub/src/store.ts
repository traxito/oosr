import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CapabilityManifest,
  HomePolicy,
  OosrEvent,
  PrivateJwk,
  PublicJwk,
  SkillPackage,
  SkillRef,
} from '@oosr/core';

export interface HubIdentity {
  hub: string;
  scope_id: string;
  created_at: string;
  key: PrivateJwk;
  owner_token_sha256: string;
}

export interface RobotRecord {
  robot: string;
  public_jwk: PublicJwk;
  capability: CapabilityManifest;
  token_sha256: string;
  paired_at: string;
  device_cert?: string;
  revoked_at?: string;
}

export interface PairingRequest {
  device_code_sha256: string;
  user_code: string;
  capability: CapabilityManifest;
  public_jwk: PublicJwk;
  device_cert?: string;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'approved' | 'denied';
  /** Plain token, held only until the robot polls once. */
  issued_token?: string;
}

export interface Enrolment {
  id: string;
  status: 'pending' | 'confirmed' | 'rejected';
  robot: string;
  created_at: string;
  tag_family: string;
  tag_id: number;
  tag_size_mm: number;
  proposed_type: string;
  confidence?: number;
  zone?: string;
  skills?: SkillRef[];
  gs1_digital_link?: string;
  object?: string;
}

export interface Approval {
  id: string;
  status: 'pending' | 'granted' | 'denied' | 'consumed';
  object: string;
  skill: string;
  task: string;
  robot: string;
  created_at: string;
  decided_at?: string;
}

export interface MutableState {
  policy: HomePolicy;
  robots: Record<string, RobotRecord>;
  pairing: PairingRequest[];
  enrolments: Enrolment[];
  approvals: Approval[];
  pinned_keys: Record<string, PublicJwk>;
}

/**
 * Plain-file persistence: hub.json (identity), state.json (non-event state),
 * events.jsonl (append-only log, the source of truth) and skills/ (installed packages).
 */
export class Store {
  constructor(readonly dir: string) {}

  get initialized(): boolean {
    return existsSync(join(this.dir, 'hub.json'));
  }

  init(identity: HubIdentity, state: MutableState): void {
    mkdirSync(join(this.dir, 'skills'), { recursive: true });
    this.writeJson('hub.json', identity);
    this.saveState(state);
    writeFileSync(join(this.dir, 'events.jsonl'), '');
  }

  identity(): HubIdentity {
    return this.readJson('hub.json');
  }

  loadState(): MutableState {
    return this.readJson('state.json');
  }

  saveState(state: MutableState): void {
    this.writeJson('state.json', state);
  }

  loadEvents(): OosrEvent[] {
    const raw = readFileSync(join(this.dir, 'events.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as OosrEvent);
  }

  appendEvent(ev: OosrEvent): void {
    appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(ev)}\n`);
  }

  loadSkills(): SkillPackage[] {
    const dir = join(this.dir, 'skills');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as SkillPackage);
  }

  saveSkill(pkg: SkillPackage): void {
    this.writeJson(join('skills', skillFile(pkg.manifest.id, pkg.manifest.version)), pkg);
  }

  deleteSkill(id: string, version: string): void {
    rmSync(join(this.dir, 'skills', skillFile(id, version)), { force: true });
  }

  private readJson<T>(name: string): T {
    return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
  }

  private writeJson(name: string, value: unknown): void {
    const path = join(this.dir, name);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  }
}

function skillFile(id: string, version: string): string {
  return `${encodeURIComponent(id)}@${version}.json`;
}
