import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEvent, generateKeyPair, localMonth, signEvent, uuidv7, type SkillManifest } from '@oosr/core';
import { Hub, auditRobot } from '@oosr/hub';
import { ClientError, SimRobot, type RobotClient } from '@oosr/sim';
import { EXTERNAL, acmeCapability, ficusManifest, humanoidCapability, startEnv, vacuumCapability, type Env } from './harness.js';

const FICUS_REF = 'skill:vivero-x.es/ficus-lyrata-care';
const SKILL = `${FICUS_REF}@1.2.0`;
const CONFIRM = { name: 'Living room ficus', zone: 'living-room', attributes: { pot_volume_l: 3 }, skills: [{ ref: FICUS_REF, min_version: '1.0.0' }] };

async function expectError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e, `expected ${status} ${code}`).toBeInstanceOf(ClientError);
  expect({ status: (e as ClientError).status, code: (e as ClientError).code }).toEqual({ status, code });
}

/** Installs a variant of the fixture skill under another id (same publisher namespace). */
function variant(name: string, patch: Partial<SkillManifest>): SkillManifest {
  return { ...ficusManifest(), id: `skill:vivero-x.es/${name}`, ...patch };
}

describe('RFC-0001 §8: a Ficus lyrata watered by a robot', () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(() => env.close());

  it('runs enrolment, matching, watering, the second robot and the inspection alert', async () => {
    expect((await env.owner('POST', '/v0/skills', await env.sign(ficusManifest()))).status).toBe(201);
    const tag = env.tag(37);

    // Enrolment: the robot sees an unbound tag; nothing exists until the human confirms.
    const arm = await env.pairRobot(acmeCapability());
    await expectError(arm.resolve(env.scope, tag.id, tag.family), 404, 'unbound_tag');
    const proposal = await arm.proposeEnrolment({ tag_family: tag.family, tag_id: tag.id, tag_size_mm: 30, proposed_type: 'plant/ficus-lyrata', confidence: 0.82 });
    await expectError(arm.resolve(env.scope, tag.id, tag.family), 404, 'unbound_tag');
    const pending = await env.owner('GET', '/v0/enrolments?status=pending');
    expect(pending.body.map((e: { id: string }) => e.id)).toContain(proposal.id);
    expect((await env.owner('POST', `/v0/enrolments/${proposal.id}/confirm`, CONFIRM)).status).toBe(200);
    const { object: urn } = await arm.resolve(env.scope, tag.id, tag.family);
    expect(urn).toMatch(/^urn:oosr:obj:[a-z0-9-]+:[0-9a-f-]{36}$/);
    const events = await env.owner('GET', `/v0/objects/${urn}/events`);
    expect(events.body.map((e: { type: string }) => e.type)).toEqual(['oosr.object.enrolled']);

    // Matching: water yes, prune no (no cut).
    const byName = Object.fromEntries((await arm.tasks(urn)).map((t) => [t.task, t]));
    expect(byName.water).toMatchObject({ eligible: true, physical: true, trigger: true });
    expect(byName.prune).toMatchObject({ eligible: false, missing: ['cut'], needs_approval: true });

    // Watering cycle: 0.12 -> 240 ml (80 ml/l x 3 l) -> 0.38.
    const world = { tags: { [String(tag.id)]: { soil_moisture: 0.12 } } };
    const robot = new SimRobot(arm, world);
    const object = await arm.object(urn);
    const water = (await arm.tasks(urn)).find((t) => t.task === 'water')!;
    expect(await robot.consider(object, await arm.state(urn), water)).toMatchObject({ outcome: 'completed' });
    const state = await arm.state(urn);
    expect(state.last_watered).toBeTruthy();
    expect(state.tasks.water!.last_result).toEqual({ soil_moisture_before: 0.12, volume_ml: 240, soil_moisture_after: 0.38 });
    expect(state.measurements.soil_moisture!.value).toBe(0.38);

    // A second robot from another vendor reads the shared state: nothing to do.
    const humanoid = await env.pairRobot(humanoidCapability());
    const hWater = (await humanoid.tasks(urn)).find((t) => t.task === 'water')!;
    expect(hWater).toMatchObject({ eligible: true, trigger: false });
    expect(await new SimRobot(humanoid, world).consider(object, await humanoid.state(urn), hWater)).toMatchObject({ outcome: 'skipped' });

    // Inspection alert: the localized message comes from the signed manifest, never the robot.
    await humanoid.emit('oosr.observation.recorded', urn, { notify: { severity: 'warning', message_key: 'leaf_spots' } }, SKILL);
    const alerts = (await env.owner('GET', `/v0/objects/${urn}/state`)).body.open_alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ message_key: 'leaf_spots', messages: { en: 'Leaf spots, possible fungus' } });
    expect((await env.owner('POST', `/v0/objects/${urn}/alerts/leaf_spots/ack`)).status).toBe(200);
    expect((await env.owner('GET', `/v0/objects/${urn}/state`)).body.open_alerts).toEqual([]);

    if (!EXTERNAL) {
      // Reference hub: the log is the source of truth, a restart derives the same projection.
      const reopened = Hub.open(env.dir!);
      expect(reopened.getState(urn).last_watered).toBe(state.last_watered);
      expect(reopened.resolve(env.scope, tag.family, tag.id).object).toBe(urn);
    }
  });
});

describe('§9 hub conformance', () => {
  let env: Env;
  let arm: RobotClient;
  let urn: string;

  beforeEach(async () => {
    env = await startEnv();
    await env.owner('POST', '/v0/skills', await env.sign(ficusManifest()));
    arm = await env.pairRobot(acmeCapability());
    urn = await env.enrol(arm, env.tag(37), CONFIRM);
  });
  afterEach(() => env.close());

  it('rejects an event without a signature', async () => {
    const ev = await arm.sign('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.2 } });
    const { oosrsig: _drop, ...unsigned } = ev;
    await expectError(arm.request('POST', '/v0/events', unsigned), 422, 'invalid_event');
  });

  it('rejects an event signed with a key the robot did not pair with', async () => {
    const { privateJwk } = await generateKeyPair();
    const forged = await signEvent(
      buildEvent({ source: arm.robot, type: 'oosr.task.water.completed', subject: urn, data: { volume_ml: 0 }, lamport: 99, skill: SKILL }),
      privateJwk,
      arm.kid,
    );
    await expectError(arm.append(forged), 401, 'bad_signature');
  });

  it('rejects a tampered event', async () => {
    const ev = await arm.sign('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.2 } });
    await expectError(arm.append({ ...ev, data: { measurements: { soil_moisture: 0.9 } } }), 401, 'bad_signature');
  });

  it('rejects a second lease on the same object and task', async () => {
    const humanoid = await env.pairRobot(humanoidCapability());
    await arm.emit('oosr.task.water.started', urn, { lease_s: 600 }, SKILL);
    await expectError(humanoid.emit('oosr.task.water.started', urn, { lease_s: 600 }, SKILL), 409, 'lease_conflict');
    // Only the lease holder can complete; completing releases the lease.
    await expectError(humanoid.emit('oosr.task.water.completed', urn, { volume_ml: 100 }, SKILL), 409, 'no_lease');
    await arm.emit('oosr.task.water.completed', urn, { volume_ml: 240 }, SKILL);
    await humanoid.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL);
  });

  it('physical tasks share one lease per object; non-physical tasks run alongside', async () => {
    const pot = variant('pot-care', {
      applies_to: ['plant/pot-test'],
      tasks: [
        { name: 'water', requires: ['dispense:water'], steps: [{ p: 'dispense', liquid: 'water', volume_ml: 100, target: '$self' }] },
        { name: 'move', requires: ['grasp', 'place'] },
        { name: 'look', requires: ['inspect'] },
      ],
    });
    await env.owner('POST', '/v0/skills', await env.sign(pot));
    const humanoid = await env.pairRobot(humanoidCapability());
    const p = await env.enrol(humanoid, env.tag(50), { type: 'plant/pot-test', zone: 'living-room', skills: [] }, 'plant/pot-test');
    const ref = 'skill:vivero-x.es/pot-care@1.2.0';

    await arm.emit('oosr.task.water.started', p, { lease_s: 600 }, ref);
    await expectError(humanoid.emit('oosr.task.move.started', p, { lease_s: 600 }, ref), 409, 'lease_conflict');
    // The same robot cannot interleave two physical runs on one object either.
    await expectError(arm.emit('oosr.task.move.started', p, { lease_s: 600 }, ref), 409, 'lease_conflict');
    await humanoid.emit('oosr.task.look.started', p, { lease_s: 60 }, ref);
    await humanoid.emit('oosr.task.look.completed', p, {}, ref);
    await arm.emit('oosr.task.water.completed', p, { volume_ml: 100 }, ref);
    await humanoid.emit('oosr.task.move.started', p, { lease_s: 600 }, ref);
    const view = (await arm.tasks(p)).find((t) => t.task === 'water')!;
    expect(view.lease).toMatchObject({ robot: humanoid.robot, task: 'move' });
  });

  it('rejects writes outside the robot scopes', async () => {
    const observer = await env.pairRobot(humanoidCapability(), { write: ['oosr.observation.*'] });
    await observer.emit('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.3 } });
    await expectError(observer.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL), 403, 'scope_denied');
  });

  it('rejects writes outside the robot zones', async () => {
    const kitchenOnly = await env.pairRobot(humanoidCapability(), { zones: ['kitchen'] });
    await expectError(kitchenOnly.emit('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.3 } }), 403, 'zone_denied');
  });

  it('rejects hub-only event types from robots', async () => {
    await expectError(arm.emit('oosr.approval.granted', urn, { approval_id: 'x' }), 403, 'hub_only_type');
  });

  it('rejects a task the robot is not eligible for (outside its primitives)', async () => {
    const vacuum = await env.pairRobot(vacuumCapability());
    await expectError(vacuum.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL), 403, 'not_eligible');
  });

  it('requires a granted approval for sensitive tasks and consumes it', async () => {
    await env.owner('POST', '/v0/skills', await env.sign(variant('bonsai-care', {
      applies_to: ['plant/bonsai'],
      tasks: [{ name: 'prune', requires: ['inspect', 'cut'], requires_human_approval: true }],
    })));
    const humanoid = await env.pairRobot(humanoidCapability());
    const tree = await env.enrol(humanoid, env.tag(12), { type: 'plant/bonsai', zone: 'living-room', skills: [] });
    const ref = 'skill:vivero-x.es/bonsai-care@1.2.0';

    await expectError(humanoid.emit('oosr.task.prune.started', tree, { lease_s: 300 }, ref), 403, 'approval_required');
    const approval = await humanoid.requestApproval(tree, ref, 'prune');
    expect(approval.status).toBe('pending');
    await expectError(humanoid.emit('oosr.task.prune.started', tree, { lease_s: 300, approval_id: approval.id }, ref), 403, 'approval_required');
    expect((await env.owner('POST', `/v0/approvals/${approval.id}/grant`)).status).toBe(200);
    await humanoid.emit('oosr.task.prune.started', tree, { lease_s: 300, approval_id: approval.id }, ref);
    await humanoid.emit('oosr.task.prune.completed', tree, { foliage_removed: 0.1 }, ref);
    // Single use.
    await expectError(humanoid.emit('oosr.task.prune.started', tree, { lease_s: 300, approval_id: approval.id }, ref), 403, 'approval_required');
    const log = (await env.owner('GET', `/v0/objects/${tree}/events`)).body.map((e: { type: string }) => e.type);
    expect(log).toContain('oosr.approval.granted');
  });

  it('policy always_require_approval applies even when the skill does not ask', async () => {
    await env.updatePolicy((p) => ({ ...p, always_require_approval: ['cut'] }));
    await env.owner('POST', '/v0/skills', await env.sign(variant('hedge-care', { applies_to: ['plant/hedge'], tasks: [{ name: 'trim', requires: ['cut'] }] })));
    const humanoid = await env.pairRobot(humanoidCapability());
    const h = await env.enrol(humanoid, env.tag(13), { type: 'plant/hedge', zone: 'living-room', skills: [] });
    await expectError(humanoid.emit('oosr.task.trim.started', h, {}, 'skill:vivero-x.es/hedge-care@1.2.0'), 403, 'approval_required');
  });

  it('rejects tasks out of season', async () => {
    const month = localMonth(new Date());
    const offMonth = String((month % 12) + 1).padStart(2, '0');
    // The major version is the month, so external hubs that keep earlier runs never mix variants.
    const version = `${month}.0.0`;
    await env.owner('POST', '/v0/skills', await env.sign(variant('rose-care', {
      version,
      applies_to: ['plant/rose'],
      tasks: [{ name: 'feed', season: [offMonth], requires: ['navigate_to'] }],
    })));
    const rose = await env.enrol(arm, env.tag(14), { type: 'plant/rose', zone: 'living-room', skills: [{ ref: 'skill:vivero-x.es/rose-care', min_version: version }] });
    await expectError(arm.emit('oosr.task.feed.started', rose, {}, `skill:vivero-x.es/rose-care@${version}`), 403, 'out_of_season');
  });

  it('rejects physical tasks during quiet hours', async () => {
    const now = new Date();
    const hh = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    await env.updatePolicy((p) => ({
      ...p,
      timezone: 'UTC',
      quiet_hours: { from: hh(new Date(now.getTime() - 3_600_000)), to: hh(new Date(now.getTime() + 3_600_000)) },
    }));
    await expectError(arm.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL), 403, 'quiet_hours');
    // Observations are not physical and still go through.
    await arm.emit('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.2 } });
  });

  it('a tag without binding executes nothing', async () => {
    const t = env.tag(99);
    await expectError(arm.resolve(env.scope, t.id, t.family), 404, 'unbound_tag');
    const ghost = `urn:oosr:obj:${env.scope}:0192f5e1-0000-7000-8000-000000000000`;
    await expectError(arm.emit('oosr.observation.recorded', ghost, {}), 404, 'unknown_object');
  });

  it('notify_human only accepts message keys defined by the signed manifest', async () => {
    await expectError(
      arm.emit('oosr.observation.recorded', urn, { notify: { severity: 'critical', message_key: 'click_this_link' } }, SKILL),
      422,
      'unknown_message_key',
    );
    await expectError(arm.emit('oosr.observation.recorded', urn, { notify: { severity: 'info', message_key: 'leaf_spots' } }), 422, 'notify_without_skill');
  });

  it('a revoked robot can no longer write', async () => {
    expect((await env.owner('DELETE', `/v0/robots/${encodeURIComponent(arm.robot)}`)).status).toBe(200);
    await expectError(arm.emit('oosr.observation.recorded', urn, {}), 401, 'unauthorized');
  });

  it('treats a re-sent event as idempotent and a reused id as a conflict', async () => {
    const ev = await arm.sign('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.2 } });
    expect((await arm.append(ev)).duplicate).toBe(false);
    expect((await arm.append(ev)).duplicate).toBe(true);
    const other = await signEvent(
      buildEvent({ source: arm.robot, type: 'oosr.observation.recorded', subject: urn, data: {}, lamport: 500, id: ev.id }),
      (arm as unknown as { key: Parameters<typeof signEvent>[1] }).key,
      arm.kid,
    );
    await expectError(arm.append(other), 409, 'id_conflict');
  });

  it('the owner cannot inject robot events and robots cannot use owner endpoints', async () => {
    const ev = await arm.sign('oosr.observation.recorded', urn, {});
    expect((await env.owner('POST', '/v0/events', ev)).status).toBe(403);
    await expectError(arm.request('GET', '/v0/policy'), 403, 'owner_only');
    await expectError(arm.request('POST', `/v0/approvals/${uuidv7()}/grant`), 403, 'owner_only');
  });
});

describe('§7 device certificates', () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(() => env.close());

  async function startPairing(cap: ReturnType<typeof acmeCapability>, key: Awaited<ReturnType<typeof generateKeyPair>>['privateJwk'], cert?: string) {
    const res = await fetch(`${env.url}/v0/pair/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: cap, public_jwk: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, ...(cert ? { device_cert: cert } : {}) }),
    });
    return { status: res.status, body: await res.json() };
  }

  it('pairs a robot whose certificate binds its key, and records the attestation', async () => {
    const cap = env.robot(acmeCapability());
    const { privateJwk: key } = await generateKeyPair();
    const robot = await env.pairRobot(acmeCapability(), { key, deviceCert: await env.deviceCert(cap, key) });
    const listed = (await env.owner('GET', '/v0/robots')).body.find((r: { robot: string }) => r.robot === robot.robot);
    expect(listed.device_attestation).toMatchObject({ iss: 'did:web:acme.example', key_storage: 'tpm' });
  });

  it('rejects a certificate for another key, model, issuer or one that expired', async () => {
    const cap = env.robot(acmeCapability());
    const { privateJwk: key } = await generateKeyPair();
    const { privateJwk: other } = await generateKeyPair();
    const cases = [
      await env.deviceCert(cap, other),
      await env.deviceCert(cap, key, { model: 'acme/other-model' }),
      await env.deviceCert(cap, key, { exp: Math.floor(Date.now() / 1000) - 60 }),
    ];
    for (const cert of cases) expect(await startPairing(cap, key, cert)).toMatchObject({ status: 422, body: { error: 'invalid_device_cert' } });
    // A certificate from acme does not vouch for robots of another vendor.
    const humanoid = env.robot(humanoidCapability());
    expect(await startPairing(humanoid, key, await env.deviceCert(humanoid, key))).toMatchObject({ status: 422, body: { error: 'invalid_device_cert' } });
  });

  it('refuses robots without a certificate when the policy requires one', async () => {
    await env.updatePolicy((p) => ({ ...p, require_device_cert: true }));
    const { privateJwk: key } = await generateKeyPair();
    expect(await startPairing(env.robot(vacuumCapability()), key)).toMatchObject({ status: 403, body: { error: 'device_cert_required' } });
  });
});

describe('§5 skill trust', () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(() => env.close());

  it('refuses skills from untrusted publishers', async () => {
    await env.updatePolicy((p) => ({ ...p, trusted_publishers: p.trusted_publishers.filter((d) => d !== 'did:web:vivero-x.es') }));
    const r = await env.owner('POST', '/v0/skills', await env.sign(ficusManifest()));
    expect(r).toMatchObject({ status: 403, body: { error: 'untrusted_publisher' } });
  });

  it('refuses tampered packages and unknown primitives', async () => {
    const pkg = await env.sign(ficusManifest());
    pkg.manifest.tasks[0]!.constraints!.max_volume_ml = 5000;
    expect((await env.owner('POST', '/v0/skills', pkg)).body.error).toBe('invalid_skill');

    const bad = ficusManifest();
    bad.tasks[0]!.steps!.push({ p: 'unlock_door', object: '$self' });
    await expect(env.sign(bad)).rejects.toThrow(/lint/);
  });

  it('refuses a skill signed by one publisher under another publisher namespace', async () => {
    await expect(env.sign({ ...ficusManifest(), id: 'skill:oosr.dev/ficus-lyrata-care' })).rejects.toThrow(/namespace/);
  });

  it('falls back to the most specific skill by type when the object declares none', async () => {
    await env.owner('POST', '/v0/skills', await env.sign(ficusManifest()));
    await env.owner('POST', '/v0/skills', await env.sign(variant('plant-care', { applies_to: ['plant'] })));
    const arm = await env.pairRobot(acmeCapability());
    const ficus = await env.enrol(arm, env.tag(40), { zone: 'living-room', attributes: { pot_volume_l: 3 }, skills: [] });
    const olive = await env.enrol(arm, env.tag(41), { type: 'plant/olea-europaea', zone: 'living-room', attributes: { pot_volume_l: 3 }, skills: [] });
    expect(new Set((await arm.tasks(ficus)).map((t) => t.skill))).toEqual(new Set([SKILL]));
    expect(new Set((await arm.tasks(olive)).map((t) => t.skill))).toEqual(new Set(['skill:vivero-x.es/plant-care@1.2.0']));
  });
});

describe.skipIf(EXTERNAL)('robot-role audit (reference hub)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
    await env.owner('POST', '/v0/skills', await env.sign(ficusManifest()));
  });
  afterEach(() => env.close());

  it('the reference simulated robot is conformant', async () => {
    const arm = await env.pairRobot(acmeCapability());
    const urn = await env.enrol(arm, env.tag(37), CONFIRM);
    await new SimRobot(arm, { tags: { '37': { soil_moisture: 0.12 } } }).cycle();
    const report = await auditRobot(env.hub!, arm.robot);
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
    expect((await env.owner('GET', `/v0/robots/${encodeURIComponent(arm.robot)}/audit`)).body.ok).toBe(true);
    expect(urn).toBeTruthy();
  });

  it('flags a robot that attempts tasks outside its primitives and exceeds constraints', async () => {
    const enroller = await env.pairRobot(acmeCapability());
    const urn = await env.enrol(enroller, env.tag(37), CONFIRM);
    const sloppy = await env.pairRobot(vacuumCapability());
    await sloppy.emit('oosr.task.water.started', urn, {}, SKILL).catch(() => {});
    await enroller.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL);
    await enroller.emit('oosr.task.water.completed', urn, { volume_ml: 900 }, SKILL);

    const vacuum = await auditRobot(env.hub!, sloppy.robot);
    expect(vacuum.ok).toBe(false);
    expect(vacuum.checks.find((c) => c.id === 'no_refused_writes')).toMatchObject({ status: 'fail' });
    const arm = await auditRobot(env.hub!, enroller.robot);
    expect(arm.checks.find((c) => c.id === 'constraints_respected')).toMatchObject({ status: 'fail' });
    expect((await env.owner('GET', `/v0/rejections?robot=${encodeURIComponent(sloppy.robot)}`)).body[0]).toMatchObject({ code: 'not_eligible' });
  });
});
