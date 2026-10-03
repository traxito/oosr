import { createHash, randomBytes } from 'node:crypto';
import {
  buildEvent,
  canonicalize,
  compareEvents,
  conditionContext,
  effectiveRequires,
  emptyState,
  evaluate,
  evaluateAll,
  generateKeyPair,
  inSeason,
  matchTask,
  objectUrn,
  parseSkillRef,
  parseTaskType,
  pickVersion,
  publisherOfSkill,
  reduce,
  sensorsOf,
  signEvent,
  signingPayload,
  taskIsPhysical,
  taskNeedsApproval,
  toPublicJwk,
  typeSpecificity,
  uuidv7,
  validate,
  verifyEvent,
  verifySkillPackage,
  verifyDeviceCert,
  type Binding,
  type DeviceAttestation,
  type CapabilityManifest,
  type HomePolicy,
  type ObjectDescription,
  type ObjectState,
  type OosrEvent,
  type PublicJwk,
  type SkillManifest,
  type SkillPackage,
  type SkillRef,
  type Task,
} from '@oosr/core';
import { TrustResolver } from './trust.js';
import { DEFAULT_ROBOT_WRITE, canWrite, inQuietHours, zoneAllowed } from './policy.js';
import { Store, type Approval, type Enrolment, type HubIdentity, type MutableState, type PairingRequest, type Rejection, type RobotRecord } from './store.js';

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Principal = { kind: 'owner' } | { kind: 'robot'; robot: string };

export interface HubOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface InitOptions extends HubOptions {
  scopeId?: string;
  policy?: Partial<HomePolicy>;
}

export interface Lease {
  robot: string;
  task: string;
  started_id: string;
  expires_at: string;
}

export interface TaskView {
  skill: string;
  task: string;
  title?: string;
  eligible: boolean;
  missing: string[];
  exceeded: string[];
  physical: boolean;
  needs_approval: boolean;
  in_season: boolean;
  trigger: boolean | null;
  preconditions: boolean | null;
  sensors: string[];
  lease: Lease | null;
  /** Owner view only: paired robots that could run it. */
  robots?: string[];
}

export type HubMessage =
  | { kind: 'event'; event: OosrEvent }
  | { kind: 'inbox'; what: 'pairing' | 'enrolment' | 'approval' | 'robots' | 'skills' | 'policy' };

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const PAIRING_TTL_S = 600;
const DEFAULT_LEASE_S = 600;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const bindingKey = (family: string, tag: number) => `${family}#${tag}`;
/**
 * Tasks with a physical effect share one exclusive lease per object (watering and moving the same
 * pot at once is a conflict); tasks without physical effect lease per (object, task).
 */
const leaseKey = (object: string, task: Task) => (taskIsPhysical(task) ? `${object}|#physical` : `${object}|${task.name}`);

export class Hub {
  readonly identity: HubIdentity;
  readonly trust: TrustResolver;
  private state: MutableState;
  private events: OosrEvent[] = [];
  private byId = new Map<string, OosrEvent>();
  private objects = new Map<string, ObjectDescription>();
  private bindings = new Map<string, Binding>();
  private projections = new Map<string, ObjectState>();
  private leases = new Map<string, Lease>();
  private skills = new Map<string, Map<string, SkillPackage>>();
  private rejections: Rejection[] = [];
  private lamport = 0;
  private listeners = new Set<(m: HubMessage) => void>();
  private readonly now: () => Date;

  private constructor(
    private readonly store: Store,
    opts: HubOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.identity = store.identity();
    this.state = store.loadState();
    this.trust = new TrustResolver(() => this.state.pinned_keys, opts.fetchImpl);
    this.rejections = store.loadRejections();
    for (const pkg of store.loadSkills()) this.indexSkill(pkg);
    for (const ev of store.loadEvents().sort(compareEvents)) this.apply(ev, new Date(ev.time));
  }

  static async init(dir: string, opts: InitOptions = {}): Promise<{ hub: Hub; ownerToken: string }> {
    const store = new Store(dir);
    if (store.initialized) throw new Error(`hub already initialized in ${dir}`);
    const scope_id = opts.scopeId ?? `hub-${randomBytes(2).toString('hex')}`;
    const hubUrn = `urn:oosr:hub:${scope_id}`;
    const { privateJwk } = await generateKeyPair(`${hubUrn}#key-1`);
    const ownerToken = token('oosr_own');
    store.init(
      { hub: hubUrn, scope_id, created_at: new Date().toISOString(), key: privateJwk, owner_token_sha256: sha256(ownerToken) },
      {
        policy: { trusted_publishers: [], robots: {}, always_require_approval: ['cut'], ...opts.policy },
        robots: {},
        pairing: [],
        enrolments: [],
        approvals: [],
        pinned_keys: {},
      },
    );
    return { hub: new Hub(store, opts), ownerToken };
  }

  static open(dir: string, opts: HubOptions = {}): Hub {
    const store = new Store(dir);
    if (!store.initialized) throw new Error(`no hub in ${dir}; run "oosr-hub init" first`);
    return new Hub(store, opts);
  }

  // ---------------------------------------------------------------- auth

  authenticate(bearer: string | undefined): Principal | undefined {
    if (!bearer) return undefined;
    const h = sha256(bearer);
    if (h === this.identity.owner_token_sha256) return { kind: 'owner' };
    const robot = Object.values(this.state.robots).find((r) => r.token_sha256 === h && !r.revoked_at);
    return robot ? { kind: 'robot', robot: robot.robot } : undefined;
  }

  subscribe(fn: (m: HubMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  info() {
    return { oosr: '0.1', hub: this.identity.hub, scope_id: this.identity.scope_id, api: '/v0', lamport: this.lamport };
  }

  keys() {
    const robots: Record<string, PublicJwk> = {};
    for (const r of Object.values(this.state.robots)) robots[r.robot] = r.public_jwk;
    return { hub: toPublicJwk(this.identity.key), robots };
  }

  // ---------------------------------------------------------------- objects & state

  resolve(scope: string, family: string, tag: number): { object: string; binding: Binding } {
    if (scope !== this.identity.scope_id) throw new HubError(404, 'unknown_scope', `scope ${scope} is not served by this hub`);
    const binding = this.bindings.get(bindingKey(family, tag));
    if (!binding?.object) throw new HubError(404, 'unbound_tag', `no binding for ${family} #${tag}`);
    return { object: binding.object, binding };
  }

  listObjects(): (ObjectDescription & { state: ObjectState })[] {
    return [...this.objects.values()].map((o) => ({ ...o, state: this.getState(o.id) }));
  }

  getObject(urn: string): ObjectDescription {
    const o = this.objects.get(urn);
    if (!o) throw new HubError(404, 'unknown_object', `unknown object ${urn}`);
    return o;
  }

  getState(urn: string): ObjectState & { open_alerts: (ObjectState['open_alerts'][number] & { messages?: Record<string, string> })[] } {
    this.getObject(urn);
    const state = this.projections.get(urn) ?? emptyState(urn);
    return {
      ...state,
      open_alerts: state.open_alerts.map((a) => {
        const pkg = a.skill ? this.findSkill(a.skill) : undefined;
        const messages = pkg?.manifest.messages?.[a.message_key];
        return messages ? { ...a, messages } : a;
      }),
    };
  }

  getEvents(urn: string, since?: string): OosrEvent[] {
    this.getObject(urn);
    let evs = this.events.filter((e) => e.subject === urn);
    if (since) {
      evs = /^\d+$/.test(since) ? evs.filter((e) => e.oosrlamport > Number(since)) : evs.filter((e) => e.time > since);
    }
    return evs;
  }

  allEvents(sinceLamport = 0): OosrEvent[] {
    return this.events.filter((e) => e.oosrlamport > sinceLamport);
  }

  async updateObject(urn: string, changes: Partial<Pick<ObjectDescription, 'name' | 'location' | 'attributes' | 'skills'>>): Promise<ObjectDescription> {
    const current = this.getObject(urn);
    const allowed: (keyof typeof changes)[] = ['name', 'location', 'attributes', 'skills'];
    const clean = Object.fromEntries(Object.entries(changes).filter(([k]) => allowed.includes(k as keyof typeof changes)));
    const next = { ...current, ...clean };
    const v = validate('object', next);
    if (!v.valid) throw new HubError(422, 'invalid_object', v.errors.join('; '));
    await this.emitHub('oosr.object.updated', urn, { changes: clean });
    return this.getObject(urn);
  }

  async ackAlert(urn: string, messageKey: string): Promise<void> {
    const state = this.getState(urn);
    if (!state.open_alerts.some((a) => a.message_key === messageKey)) throw new HubError(404, 'unknown_alert', `no open alert ${messageKey}`);
    await this.emitHub('oosr.alert.acknowledged', urn, { message_key: messageKey });
  }

  // ---------------------------------------------------------------- skills

  listSkills() {
    return [...this.skills.values()].flatMap((versions) =>
      [...versions.values()].map(({ manifest: m }) => ({
        id: m.id,
        version: m.version,
        title: m.title,
        publisher: m.publisher,
        applies_to: m.applies_to,
        tasks: m.tasks.map((t) => t.name),
        trusted: this.state.policy.trusted_publishers.includes(m.publisher),
      })),
    );
  }

  getSkill(id: string, version: string): SkillPackage {
    const pkg = this.skills.get(id)?.get(version);
    if (!pkg) throw new HubError(404, 'unknown_skill', `skill ${id}@${version} is not installed`);
    return pkg;
  }

  findSkill(ref: string): SkillPackage | undefined {
    const { id, version } = parseSkillRef(ref);
    const versions = this.skills.get(id);
    if (!versions) return undefined;
    return version ? versions.get(version) : versions.get(pickVersion([...versions.keys()])!);
  }

  async installSkill(pkg: SkillPackage): Promise<SkillManifest> {
    const publisher = pkg?.manifest?.publisher;
    if (!this.state.policy.trusted_publishers.includes(publisher)) {
      throw new HubError(403, 'untrusted_publisher', `${publisher} is not in trusted_publishers`);
    }
    try {
      await verifySkillPackage(pkg, (kid) => this.trust.key(kid));
    } catch (e) {
      throw new HubError(422, 'invalid_skill', (e as Error).message);
    }
    const existing = this.skills.get(pkg.manifest.id)?.get(pkg.manifest.version);
    // ECDSA signatures are randomized: the same release re-signed differs only in `signature`.
    if (existing && canonicalize(signingPayload(existing.manifest)) !== canonicalize(signingPayload(pkg.manifest))) {
      throw new HubError(409, 'version_conflict', `${pkg.manifest.id}@${pkg.manifest.version} is installed with different content`);
    }
    this.store.saveSkill(pkg);
    this.indexSkill(pkg);
    this.notify({ kind: 'inbox', what: 'skills' });
    return pkg.manifest;
  }

  async fetchSkill(ref: string, version?: string): Promise<SkillManifest> {
    let pkg: SkillPackage;
    try {
      pkg = await this.trust.fetchPackage(ref, version);
    } catch (e) {
      throw new HubError(502, 'registry_error', (e as Error).message);
    }
    if (pkg?.manifest?.id !== ref) throw new HubError(422, 'invalid_skill', `registry returned ${pkg?.manifest?.id} for ${ref}`);
    return this.installSkill(pkg);
  }

  removeSkill(id: string, version: string): void {
    this.getSkill(id, version);
    this.skills.get(id)!.delete(version);
    this.store.deleteSkill(id, version);
    this.notify({ kind: 'inbox', what: 'skills' });
  }

  /** Skills that apply to an object: its explicit refs, or the most specific type fallback. */
  skillsFor(object: ObjectDescription): SkillPackage[] {
    const trusted = (p: SkillPackage) => this.state.policy.trusted_publishers.includes(p.manifest.publisher);
    if (object.skills.length) {
      return object.skills.flatMap((ref) => {
        const versions = this.skills.get(ref.ref);
        const v = versions && pickVersion([...versions.keys()], ref.min_version);
        const pkg = v ? versions!.get(v) : undefined;
        return pkg && trusted(pkg) ? [pkg] : [];
      });
    }
    const candidates = [...this.skills.values()]
      .map((versions) => versions.get(pickVersion([...versions.keys()])!)!)
      .filter((p) => trusted(p) && typeSpecificity(p.manifest, object.type) >= 0);
    const best = Math.max(-1, ...candidates.map((p) => typeSpecificity(p.manifest, object.type)));
    return candidates.filter((p) => typeSpecificity(p.manifest, object.type) === best);
  }

  /** Pins a did:web key (publisher or manufacturer) so it verifies without network access. */
  pinKey(kid: string, jwk: PublicJwk): void {
    if (!/^did:web:.+#.+$/.test(kid)) throw new HubError(422, 'invalid_kid', 'kid must be did:web:...#fragment');
    if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new HubError(422, 'invalid_jwk', 'expected an EC P-256 public JWK');
    this.state.pinned_keys[kid] = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
    this.save();
  }

  pinnedKeys(): Record<string, PublicJwk> {
    return this.state.pinned_keys;
  }

  // ---------------------------------------------------------------- tasks

  tasksFor(urn: string, principal: Principal, robotParam?: string): TaskView[] {
    const object = this.getObject(urn);
    const state = this.projections.get(urn) ?? emptyState(urn);
    const now = this.now();
    const ctx = conditionContext(state, now);
    const robotUrn = principal.kind === 'robot' ? principal.robot : robotParam;
    const robot = robotUrn ? this.activeRobot(robotUrn) : undefined;
    const paired = Object.values(this.state.robots).filter((r) => !r.revoked_at);

    return this.skillsFor(object).flatMap(({ manifest }) =>
      manifest.tasks.map((task) => {
        const match = robot ? matchTask(task, robot.capability, object) : undefined;
        const lease = this.liveLease(urn, task, now);
        const trig = task.trigger ? evaluate(task.trigger, ctx) : true;
        const pre = evaluateAll(task.preconditions, ctx);
        const view: TaskView = {
          skill: `${manifest.id}@${manifest.version}`,
          task: task.name,
          ...(task.title_key ? { title: task.title_key } : {}),
          eligible: match ? match.eligible : paired.some((r) => matchTask(task, r.capability, object).eligible),
          missing: match?.missing ?? [],
          exceeded: match?.exceeded ?? [],
          physical: taskIsPhysical(task),
          needs_approval: taskNeedsApproval(task, this.state.policy),
          in_season: inSeason(task, now, { hemisphere: this.state.policy.hemisphere, timeZone: this.state.policy.timezone }),
          trigger: trig ?? null,
          preconditions: pre ?? null,
          sensors: [...new Set([...sensorsOf(task.trigger), ...(task.preconditions ?? []).flatMap(sensorsOf)])],
          lease: lease ?? null,
        };
        if (!robot) view.robots = paired.filter((r) => matchTask(task, r.capability, object).eligible).map((r) => r.robot);
        return view;
      }),
    );
  }

  private liveLease(object: string, task: Task, now: Date): Lease | undefined {
    const l = this.leases.get(leaseKey(object, task));
    return l && new Date(l.expires_at) > now ? l : undefined;
  }

  // ---------------------------------------------------------------- event intake

  /**
   * The single write path for robots. Every check here is a conformance requirement:
   * schema, authenticated source, signature, write scope, zone, skill trust, matching,
   * season, quiet hours, approval and lease.
   */
  async appendRobotEvent(principal: Principal, ev: OosrEvent): Promise<{ event: OosrEvent; duplicate: boolean }> {
    try {
      return await this.intake(principal, ev);
    } catch (e) {
      if (e instanceof HubError && principal.kind === 'robot') this.recordRejection(principal.robot, e, ev);
      throw e;
    }
  }

  /** Refused robot writes, newest last. Audits use them: a conformant robot rarely triggers these. */
  listRejections(robot?: string): Rejection[] {
    return this.rejections.filter((r) => !robot || r.robot === robot);
  }

  private recordRejection(robot: string, e: HubError, ev: OosrEvent | undefined): void {
    const r: Rejection = {
      at: this.now().toISOString(),
      robot,
      code: e.code,
      message: e.message,
      ...(typeof ev?.id === 'string' ? { event_id: ev.id } : {}),
      ...(typeof ev?.type === 'string' ? { type: ev.type } : {}),
      ...(typeof ev?.subject === 'string' ? { subject: ev.subject } : {}),
    };
    this.rejections.push(r);
    this.store.appendRejection(r);
  }

  private async intake(principal: Principal, ev: OosrEvent): Promise<{ event: OosrEvent; duplicate: boolean }> {
    if (principal.kind !== 'robot') throw new HubError(403, 'robots_only', 'only paired robots append events; humans act through the app endpoints');
    const v = validate('event', ev);
    if (!v.valid) throw new HubError(422, 'invalid_event', v.errors.join('; '));
    if (ev.source !== principal.robot) throw new HubError(403, 'source_mismatch', `token belongs to ${principal.robot}, event source is ${ev.source}`);
    const robot = this.activeRobot(principal.robot);

    try {
      const kid = await verifyEvent(ev, robot.public_jwk);
      if (!kid.startsWith(`${robot.robot}#`)) throw new Error(`kid ${kid} does not belong to ${robot.robot}`);
    } catch (e) {
      throw new HubError(401, 'bad_signature', `event signature rejected: ${(e as Error).message}`);
    }

    const dup = this.byId.get(ev.id);
    if (dup) {
      if (canonicalize(dup) === canonicalize(ev)) return { event: dup, duplicate: true };
      throw new HubError(409, 'id_conflict', `event ${ev.id} already exists with different content`);
    }

    const now = this.now();
    if (new Date(ev.time).getTime() - now.getTime() > MAX_CLOCK_SKEW_MS) throw new HubError(422, 'clock_skew', 'event time is in the future');

    const robotTypes = /^oosr\.(observation\.recorded|task\.[a-z0-9_]+\.(started|completed|failed))$/;
    if (!robotTypes.test(ev.type)) throw new HubError(403, 'hub_only_type', `${ev.type} can only be emitted by the hub`);
    const policy = this.state.policy;
    if (!canWrite(policy, robot.robot, ev.type)) throw new HubError(403, 'scope_denied', `${robot.robot} may not write ${ev.type}`);

    const object = this.objects.get(ev.subject);
    if (!object) throw new HubError(404, 'unknown_object', `unknown object ${ev.subject}`);
    if (!zoneAllowed(policy, robot.robot, object.location?.zone)) {
      throw new HubError(403, 'zone_denied', `${robot.robot} is not allowed in zone ${object.location?.zone ?? '(none)'}`);
    }

    const skill = ev.oosrskill ? this.skillForEvent(ev.oosrskill, object) : undefined;
    let consume: Approval | undefined;

    if (ev.type === 'oosr.observation.recorded') {
      const notify = ev.data.notify as { message_key: string } | undefined;
      if (notify) {
        if (!skill) throw new HubError(422, 'notify_without_skill', 'notify requires oosrskill so the message comes from a signed manifest');
        if (!skill.messages?.[notify.message_key]) throw new HubError(422, 'unknown_message_key', `${notify.message_key} is not defined by ${skill.id}`);
      }
    }

    const tt = parseTaskType(ev.type);
    if (tt) {
      const task = skill!.tasks.find((t) => t.name === tt.task);
      if (!task) throw new HubError(422, 'unknown_task', `${skill!.id} has no task ${tt.task}`);
      const match = matchTask(task, robot.capability, object);
      if (!match.eligible) {
        throw new HubError(403, 'not_eligible', `robot not eligible for ${tt.task}: missing [${match.missing}] exceeded [${match.exceeded}]`);
      }
      const physical = taskIsPhysical(task);
      const current = this.leases.get(leaseKey(object.id, task));

      if (tt.phase === 'started') {
        const live = this.liveLease(object.id, task, now);
        const renewal = live?.robot === robot.robot && live.task === task.name;
        if (live && !renewal) {
          throw new HubError(409, 'lease_conflict', `object is leased by ${live.robot} for ${live.task} until ${live.expires_at}`);
        }
        if (!inSeason(task, now, { hemisphere: policy.hemisphere, timeZone: policy.timezone })) {
          throw new HubError(403, 'out_of_season', `${task.name} is out of season`);
        }
        if (physical && inQuietHours(policy, now)) throw new HubError(403, 'quiet_hours', 'physical tasks are not allowed during quiet hours');
        if (!renewal && taskNeedsApproval(task, policy)) {
          consume = this.checkApproval(ev, task, skill!, robot.robot);
        }
      } else if (physical || current?.task === task.name) {
        if (!current || current.robot !== robot.robot || current.task !== task.name) {
          throw new HubError(409, 'no_lease', `${tt.phase} without a run started by this robot (lease missing or taken over)`);
        }
      }
    }

    if (consume) {
      consume.status = 'consumed';
      this.save();
      this.notify({ kind: 'inbox', what: 'approval' });
    }
    this.commit(ev, now);
    return { event: ev, duplicate: false };
  }

  private skillForEvent(ref: string, object: ObjectDescription): SkillManifest {
    const pkg = this.findSkill(ref);
    if (!pkg) throw new HubError(422, 'unknown_skill', `skill ${ref} is not installed`);
    if (!this.state.policy.trusted_publishers.includes(pkg.manifest.publisher)) {
      throw new HubError(403, 'untrusted_publisher', `${pkg.manifest.publisher} is no longer trusted`);
    }
    if (!this.skillsFor(object).some((p) => p.manifest.id === pkg.manifest.id)) {
      throw new HubError(422, 'skill_not_applicable', `${pkg.manifest.id} does not apply to ${object.id}`);
    }
    return pkg.manifest;
  }

  private checkApproval(ev: OosrEvent, task: Task, skill: SkillManifest, robot: string): Approval {
    const id = ev.data.approval_id;
    const a = typeof id === 'string' ? this.state.approvals.find((x) => x.id === id) : undefined;
    if (!a || a.status !== 'granted') throw new HubError(403, 'approval_required', `${task.name} requires a granted approval (data.approval_id)`);
    if (a.object !== ev.subject || a.task !== task.name || a.robot !== robot || parseSkillRef(a.skill).id !== skill.id) {
      throw new HubError(403, 'approval_mismatch', 'approval does not cover this object, task, skill and robot');
    }
    return a;
  }

  // ---------------------------------------------------------------- pairing (RFC 8628)

  async startPairing(body: { capability: CapabilityManifest; public_jwk: PublicJwk; device_cert?: string }) {
    const v = validate('capability', body?.capability);
    if (!v.valid) throw new HubError(422, 'invalid_capability', v.errors.join('; '));
    const jwk = body.public_jwk;
    if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new HubError(422, 'invalid_jwk', 'expected an EC P-256 public JWK');
    const attestation = await this.attest(body);
    const deviceCode = randomBytes(32).toString('base64url');
    const bytes = randomBytes(8);
    const raw = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('');
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const now = this.now();
    this.prunePairing(now);
    this.state.pairing.push({
      device_code_sha256: sha256(deviceCode),
      user_code: userCode,
      capability: body.capability,
      public_jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      ...(body.device_cert ? { device_cert: body.device_cert } : {}),
      ...(attestation ? { device_attestation: attestation } : {}),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PAIRING_TTL_S * 1000).toISOString(),
      status: 'pending',
    });
    this.save();
    this.notify({ kind: 'inbox', what: 'pairing' });
    return {
      device_code: deviceCode,
      user_code: userCode,
      expires_in: PAIRING_TTL_S,
      interval: 2,
      device_attestation: attestation ?? null,
    };
  }

  /**
   * Verifies the manufacturer's device certificate, if any. An invalid certificate always fails
   * pairing; a missing one fails only when the policy requires certificates.
   */
  private async attest(body: { capability: CapabilityManifest; public_jwk: PublicJwk; device_cert?: string }): Promise<DeviceAttestation | undefined> {
    const policy = this.state.policy;
    if (!body.device_cert) {
      if (policy.require_device_cert) throw new HubError(403, 'device_cert_required', 'this household only pairs robots with a valid device certificate');
      return undefined;
    }
    try {
      const claims = await verifyDeviceCert(body.device_cert, (kid) => this.trust.key(kid), {
        robot: body.capability.robot,
        model: body.capability.model,
        publicJwk: body.public_jwk,
        manufacturers: policy.trusted_manufacturers ?? {},
        now: this.now(),
      });
      return { iss: claims.iss, ...(claims.key_storage ? { key_storage: claims.key_storage } : {}), verified_at: this.now().toISOString() };
    } catch (e) {
      throw new HubError(422, 'invalid_device_cert', (e as Error).message);
    }
  }

  pollPairing(deviceCode: string): { access_token: string; token_type: 'Bearer'; robot: string; hub: string; scope_id: string } {
    const req = this.state.pairing.find((p) => p.device_code_sha256 === sha256(deviceCode ?? ''));
    if (!req) throw new HubError(400, 'invalid_grant', 'unknown device_code');
    if (new Date(req.expires_at) < this.now() && req.status === 'pending') throw new HubError(400, 'expired_token', 'pairing expired');
    if (req.status === 'pending') throw new HubError(400, 'authorization_pending', 'waiting for the owner');
    if (req.status === 'denied') throw new HubError(400, 'access_denied', 'the owner denied pairing');
    const tokenValue = req.issued_token;
    if (!tokenValue) throw new HubError(400, 'invalid_grant', 'token already delivered');
    delete req.issued_token;
    this.state.pairing = this.state.pairing.filter((p) => p !== req);
    this.save();
    return { access_token: tokenValue, token_type: 'Bearer', robot: req.capability.robot, hub: this.identity.hub, scope_id: this.identity.scope_id };
  }

  listPairing(): Omit<PairingRequest, 'device_code_sha256' | 'issued_token'>[] {
    this.prunePairing(this.now());
    return this.state.pairing
      .filter((p) => p.status === 'pending')
      .map(({ device_code_sha256: _d, issued_token: _t, ...rest }) => rest);
  }

  approvePairing(userCode: string, opts: { write?: string[]; zones?: string[] } = {}): RobotRecord {
    const req = this.pendingPairing(userCode);
    const robotToken = token('oosr_rbt');
    const record: RobotRecord = {
      robot: req.capability.robot,
      public_jwk: req.public_jwk,
      capability: req.capability,
      token_sha256: sha256(robotToken),
      paired_at: this.now().toISOString(),
      ...(req.device_cert ? { device_cert: req.device_cert } : {}),
      ...(req.device_attestation ? { device_attestation: req.device_attestation } : {}),
    };
    this.state.robots[record.robot] = record;
    const robots = (this.state.policy.robots ??= {});
    const prev = robots[record.robot];
    const zones = opts.zones ?? prev?.zones;
    robots[record.robot] = { write: opts.write ?? prev?.write ?? DEFAULT_ROBOT_WRITE, ...(zones ? { zones } : {}) };
    req.status = 'approved';
    req.issued_token = robotToken;
    this.save();
    this.notify({ kind: 'inbox', what: 'robots' });
    return record;
  }

  denyPairing(userCode: string): void {
    this.pendingPairing(userCode).status = 'denied';
    this.save();
    this.notify({ kind: 'inbox', what: 'pairing' });
  }

  private pendingPairing(userCode: string): PairingRequest {
    const req = this.state.pairing.find((p) => p.user_code === String(userCode).toUpperCase() && p.status === 'pending');
    if (!req || new Date(req.expires_at) < this.now()) throw new HubError(404, 'unknown_code', 'no pending pairing with that code');
    return req;
  }

  private prunePairing(now: Date): void {
    const before = this.state.pairing.length;
    // Keep expired entries one extra TTL so a polling robot gets "expired_token" rather than "invalid_grant".
    this.state.pairing = this.state.pairing.filter((p) => new Date(p.expires_at).getTime() + PAIRING_TTL_S * 1000 > now.getTime());
    if (this.state.pairing.length !== before) this.save();
  }

  // ---------------------------------------------------------------- robots

  listRobots() {
    return Object.values(this.state.robots).map(({ token_sha256: _t, ...r }) => ({ ...r, policy: this.state.policy.robots?.[r.robot] ?? {} }));
  }

  updateCapability(principal: Principal, cap: CapabilityManifest): void {
    if (principal.kind !== 'robot') throw new HubError(403, 'robots_only', 'only the robot publishes its capability manifest');
    const v = validate('capability', cap);
    if (!v.valid) throw new HubError(422, 'invalid_capability', v.errors.join('; '));
    if (cap.robot !== principal.robot) throw new HubError(403, 'source_mismatch', 'capability.robot must match the token');
    this.activeRobot(principal.robot).capability = cap;
    this.save();
    this.notify({ kind: 'inbox', what: 'robots' });
  }

  revokeRobot(urn: string): void {
    const r = this.state.robots[urn];
    if (!r) throw new HubError(404, 'unknown_robot', `unknown robot ${urn}`);
    r.revoked_at = this.now().toISOString();
    for (const [k, l] of this.leases) if (l.robot === urn) this.leases.delete(k);
    this.save();
    this.notify({ kind: 'inbox', what: 'robots' });
  }

  private activeRobot(urn: string): RobotRecord {
    const r = this.state.robots[urn];
    if (!r || r.revoked_at) throw new HubError(403, 'robot_revoked', `robot ${urn} is not paired`);
    return r;
  }

  // ---------------------------------------------------------------- enrolment

  proposeEnrolment(principal: Principal, body: Partial<Enrolment>): Enrolment {
    if (principal.kind !== 'robot') throw new HubError(403, 'robots_only', 'enrolment is proposed by a robot that sees the tag');
    const b = body ?? {};
    const binding = { scope_id: this.identity.scope_id, tag_family: b.tag_family, tag_id: b.tag_id, tag_size_mm: b.tag_size_mm };
    const v = validate('binding', binding);
    if (!v.valid) throw new HubError(422, 'invalid_binding', v.errors.join('; '));
    if (typeof b.proposed_type !== 'string' || !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(b.proposed_type)) {
      throw new HubError(422, 'invalid_type', 'proposed_type must be a taxonomy path like plant/ficus-lyrata');
    }
    const existing = this.bindings.get(bindingKey(b.tag_family!, b.tag_id!));
    if (existing) throw new HubError(409, 'already_bound', `tag is bound to ${existing.object}`);
    const dup = this.state.enrolments.find(
      (e) => e.status === 'pending' && e.tag_family === b.tag_family && e.tag_id === b.tag_id,
    );
    if (dup) return dup;
    const skills = Array.isArray(b.skills) ? b.skills.filter((s) => typeof s?.ref === 'string') : undefined;
    const enrolment: Enrolment = {
      id: uuidv7(),
      status: 'pending',
      robot: principal.robot,
      created_at: this.now().toISOString(),
      tag_family: b.tag_family!,
      tag_id: b.tag_id!,
      tag_size_mm: b.tag_size_mm!,
      proposed_type: b.proposed_type,
      ...(typeof b.confidence === 'number' ? { confidence: b.confidence } : {}),
      ...(typeof b.zone === 'string' ? { zone: b.zone } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(typeof b.gs1_digital_link === 'string' ? { gs1_digital_link: b.gs1_digital_link } : {}),
    };
    this.state.enrolments.push(enrolment);
    this.save();
    this.notify({ kind: 'inbox', what: 'enrolment' });
    return enrolment;
  }

  listEnrolments(status?: string): Enrolment[] {
    return this.state.enrolments.filter((e) => !status || e.status === status);
  }

  getEnrolment(id: string): Enrolment {
    const e = this.state.enrolments.find((x) => x.id === id);
    if (!e) throw new HubError(404, 'unknown_enrolment', `unknown enrolment ${id}`);
    return e;
  }

  /** Human confirmation is the only way a binding is created. */
  async confirmEnrolment(
    id: string,
    body: { type?: string; name?: string; zone?: string; attributes?: Record<string, unknown>; skills?: SkillRef[] } = {},
  ): Promise<{ object: ObjectDescription; skill_errors: string[] }> {
    const e = this.getEnrolment(id);
    if (e.status !== 'pending') throw new HubError(409, 'not_pending', `enrolment is ${e.status}`);
    if (this.bindings.has(bindingKey(e.tag_family, e.tag_id))) throw new HubError(409, 'already_bound', 'tag was bound meanwhile');

    const skills = body.skills ?? e.skills ?? [];
    const skill_errors: string[] = [];
    for (const ref of skills) {
      if (this.skills.has(ref.ref)) continue;
      const publisher = this.publisherFromRef(ref.ref);
      if (!publisher || !this.state.policy.trusted_publishers.includes(publisher)) {
        skill_errors.push(`${ref.ref}: publisher not trusted`);
        continue;
      }
      try {
        await this.fetchSkill(ref.ref);
      } catch (err) {
        skill_errors.push(`${ref.ref}: ${(err as Error).message}`);
      }
    }

    const now = this.now();
    const urn = objectUrn(this.identity.scope_id, uuidv7(now.getTime()));
    const zone = body.zone ?? e.zone;
    const binding: Binding = {
      scope_id: this.identity.scope_id,
      tag_family: e.tag_family,
      tag_id: e.tag_id,
      tag_size_mm: e.tag_size_mm,
      object: urn,
      bound_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      bound_by: e.robot,
    };
    const object: ObjectDescription = {
      '@context': 'https://oosr.dev/ns/v0',
      id: urn,
      type: body.type ?? e.proposed_type,
      ...(body.name ? { name: body.name } : {}),
      ...(zone ? { location: { zone } } : {}),
      skills,
      ...(body.attributes ? { attributes: body.attributes } : {}),
      bindings: [binding],
    };
    const v = validate('object', object);
    if (!v.valid) throw new HubError(422, 'invalid_object', v.errors.join('; '));

    await this.emitHub('oosr.object.enrolled', urn, { object, binding, enrolment: e.id });
    e.status = 'confirmed';
    e.object = urn;
    this.save();
    this.notify({ kind: 'inbox', what: 'enrolment' });
    return { object: this.getObject(urn), skill_errors };
  }

  rejectEnrolment(id: string): void {
    const e = this.getEnrolment(id);
    if (e.status !== 'pending') throw new HubError(409, 'not_pending', `enrolment is ${e.status}`);
    e.status = 'rejected';
    this.save();
    this.notify({ kind: 'inbox', what: 'enrolment' });
  }

  async revokeBinding(family: string, tag: number): Promise<void> {
    const b = this.bindings.get(bindingKey(family, Number(tag)));
    if (!b?.object) throw new HubError(404, 'unbound_tag', `no binding for ${family} #${tag}`);
    await this.emitHub('oosr.binding.revoked', b.object, { binding: b });
  }

  private publisherFromRef(ref: string): string | undefined {
    try {
      return publisherOfSkill(ref);
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- approvals

  requestApproval(principal: Principal, body: { object: string; skill: string; task: string }): Approval {
    if (principal.kind !== 'robot') throw new HubError(403, 'robots_only', 'approvals are requested by robots');
    const object = this.getObject(body?.object);
    const skill = this.skillForEvent(body.skill, object);
    const task = skill.tasks.find((t) => t.name === body.task);
    if (!task) throw new HubError(422, 'unknown_task', `${skill.id} has no task ${body.task}`);
    const robot = this.activeRobot(principal.robot);
    const match = matchTask(task, robot.capability, object);
    if (!match.eligible) throw new HubError(403, 'not_eligible', `robot not eligible for ${task.name}`);
    const existing = this.state.approvals.find(
      (a) => a.object === object.id && a.task === task.name && a.robot === robot.robot && (a.status === 'pending' || a.status === 'granted'),
    );
    if (existing) return existing;
    const approval: Approval = {
      id: uuidv7(),
      status: 'pending',
      object: object.id,
      skill: `${skill.id}@${skill.version}`,
      task: task.name,
      robot: robot.robot,
      created_at: this.now().toISOString(),
    };
    this.state.approvals.push(approval);
    this.save();
    this.notify({ kind: 'inbox', what: 'approval' });
    return approval;
  }

  listApprovals(status?: string): (Approval & { requires: string[] })[] {
    return this.state.approvals
      .filter((a) => !status || a.status === status)
      .map((a) => {
        const task = this.findSkill(a.skill)?.manifest.tasks.find((t) => t.name === a.task);
        return { ...a, requires: task ? effectiveRequires(task) : [] };
      });
  }

  getApproval(id: string): Approval {
    const a = this.state.approvals.find((x) => x.id === id);
    if (!a) throw new HubError(404, 'unknown_approval', `unknown approval ${id}`);
    return a;
  }

  async decideApproval(id: string, grant: boolean): Promise<Approval> {
    const a = this.getApproval(id);
    if (a.status !== 'pending') throw new HubError(409, 'not_pending', `approval is ${a.status}`);
    a.status = grant ? 'granted' : 'denied';
    a.decided_at = this.now().toISOString();
    this.save();
    await this.emitHub(grant ? 'oosr.approval.granted' : 'oosr.approval.denied', a.object, {
      approval_id: a.id,
      task: a.task,
      robot: a.robot,
      decided_by: 'owner',
    }, a.skill);
    this.notify({ kind: 'inbox', what: 'approval' });
    return a;
  }

  // ---------------------------------------------------------------- policy

  getPolicy(): HomePolicy {
    return this.state.policy;
  }

  setPolicy(policy: HomePolicy): HomePolicy {
    const v = validate('policy', policy);
    if (!v.valid) throw new HubError(422, 'invalid_policy', v.errors.join('; '));
    this.state.policy = policy;
    this.save();
    this.notify({ kind: 'inbox', what: 'policy' });
    return policy;
  }

  // ---------------------------------------------------------------- internals

  private async emitHub(type: string, subject: string, data: Record<string, unknown>, skill?: string): Promise<OosrEvent> {
    const now = this.now();
    const ev = await signEvent(
      buildEvent({ source: this.identity.hub, type, subject, data, lamport: this.lamport + 1, time: now, ...(skill ? { skill } : {}) }),
      this.identity.key,
      `${this.identity.hub}#key-1`,
    );
    this.commit(ev, now);
    return ev;
  }

  private commit(ev: OosrEvent, receivedAt: Date): void {
    this.store.appendEvent(ev);
    this.apply(ev, receivedAt);
    this.notify({ kind: 'event', event: ev });
  }

  /** Derives every in-memory view from one event. Also used to replay the log at startup. */
  private apply(ev: OosrEvent, receivedAt: Date): void {
    this.events.push(ev);
    this.byId.set(ev.id, ev);
    this.lamport = Math.max(this.lamport, ev.oosrlamport);

    if (ev.type === 'oosr.object.enrolled') {
      const { object, binding } = ev.data as { object: ObjectDescription; binding: Binding };
      // Views never share references with the log: the log is signed and must stay intact.
      this.objects.set(object.id, structuredClone(object));
      this.bindings.set(bindingKey(binding.tag_family, binding.tag_id), structuredClone(binding));
    } else if (ev.type === 'oosr.object.updated') {
      const o = this.objects.get(ev.subject);
      if (o) this.objects.set(o.id, { ...o, ...structuredClone(ev.data.changes as object) });
    } else if (ev.type === 'oosr.binding.revoked') {
      const { binding } = ev.data as { binding: Binding };
      this.bindings.delete(bindingKey(binding.tag_family, binding.tag_id));
      const o = this.objects.get(ev.subject);
      if (o) {
        o.bindings = (o.bindings ?? []).filter((b) => !(b.tag_family === binding.tag_family && b.tag_id === binding.tag_id));
      }
    }

    const tt = parseTaskType(ev.type);
    const task = tt && ev.oosrskill ? this.findSkill(ev.oosrskill)?.manifest.tasks.find((t) => t.name === tt.task) : undefined;
    if (tt && task) {
      const key = leaseKey(ev.subject, task);
      const held = this.leases.get(key);
      if (tt.phase === 'started') {
        const leaseS = typeof ev.data.lease_s === 'number' ? ev.data.lease_s : DEFAULT_LEASE_S;
        this.leases.set(key, {
          robot: ev.source,
          task: task.name,
          started_id: ev.id,
          expires_at: new Date(receivedAt.getTime() + leaseS * 1000).toISOString(),
        });
      } else if (held?.robot === ev.source && held.task === task.name) {
        this.leases.delete(key);
      }
    }

    const state = this.projections.get(ev.subject) ?? emptyState(ev.subject);
    this.projections.set(ev.subject, reduce(state, ev));
  }

  private indexSkill(pkg: SkillPackage): void {
    const m = pkg.manifest;
    if (!this.skills.has(m.id)) this.skills.set(m.id, new Map());
    this.skills.get(m.id)!.set(m.version, pkg);
  }

  private save(): void {
    this.store.saveState(this.state);
  }

  private notify(m: HubMessage): void {
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch {
        // A broken subscriber must never break the write path.
      }
    }
  }
}
