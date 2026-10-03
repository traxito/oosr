import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, localMonth, signEvent, buildEvent, uuidv7, type SkillManifest } from '@oosr/core';
import { Hub } from '@oosr/hub';
import { ClientError, SimRobot, type RobotClient } from '@oosr/sim';
import { acmeCapability, ficusManifest, humanoidCapability, startEnv, vacuumCapability, type Env } from './harness.js';

const FICUS_REF = 'skill:vivero-x.es/ficus-lyrata-care';
const SKILL = `${FICUS_REF}@1.2.0`;
const CONFIRM = { name: 'Ficus del salón', zone: 'salon', attributes: { pot_volume_l: 3 }, skills: [{ ref: FICUS_REF, min_version: '1.0.0' }] };

async function expectError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e, `expected ${status} ${code}`).toBeInstanceOf(ClientError);
  expect({ status: (e as ClientError).status, code: (e as ClientError).code }).toEqual({ status, code });
}

describe('RFC-0001 §8: a Ficus lyrata watered by a robot', () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(() => env.close());

  it('runs enrolment, matching, watering, the second robot and the inspection alert', async () => {
    expect((await env.owner('POST', '/v0/skills', await env.sign(ficusManifest()))).status).toBe(201);

    // Alta: the robot sees an unbound tag; nothing exists until the human confirms.
    const arm = await env.pairRobot(acmeCapability());
    await expectError(arm.resolve('hub-7f3a', 37), 404, 'unbound_tag');
    const proposal = await arm.proposeEnrolment({ tag_id: 37, tag_size_mm: 30, proposed_type: 'plant/ficus-lyrata', confidence: 0.82 });
    await expectError(arm.resolve('hub-7f3a', 37), 404, 'unbound_tag');
    const pending = await env.owner('GET', '/v0/enrolments?status=pending');
    expect(pending.body.map((e: { id: string }) => e.id)).toEqual([proposal.id]);
    const confirmed = await env.owner('POST', `/v0/enrolments/${proposal.id}/confirm`, CONFIRM);
    expect(confirmed.status).toBe(200);
    const { object: urn } = await arm.resolve('hub-7f3a', 37);
    expect(urn).toMatch(/^urn:oosr:obj:hub-7f3a:[0-9a-f-]{36}$/);
    const events = await env.owner('GET', `/v0/objects/${urn}/events`);
    expect(events.body.map((e: { type: string }) => e.type)).toEqual(['oosr.object.enrolled']);

    // Matching: water yes, prune no (no cut).
    const tasks = await arm.tasks(urn);
    const byName = Object.fromEntries(tasks.map((t) => [t.task, t]));
    expect(byName.water).toMatchObject({ eligible: true, physical: true, trigger: true });
    expect(byName.prune).toMatchObject({ eligible: false, missing: ['cut'], needs_approval: true });

    // Watering cycle: 0.12 -> 240 ml (80 ml/l x 3 l) -> 0.38.
    const world = { tags: { '37': { soil_moisture: 0.12 } } };
    const reports = await new SimRobot(arm, world).cycle();
    expect(reports.find((r) => r.task === 'water')).toMatchObject({ outcome: 'completed' });
    const state = await arm.state(urn);
    expect(state.last_watered).toBeTruthy();
    expect(state.tasks.water!.last_result).toEqual({ soil_moisture_before: 0.12, volume_ml: 240, soil_moisture_after: 0.38 });
    expect(state.measurements.soil_moisture!.value).toBe(0.38);

    // Second robot from another vendor: reads the shared state, nothing to do.
    const humanoid = await env.pairRobot(humanoidCapability());
    const hTasks = await humanoid.tasks(urn);
    expect(hTasks.find((t) => t.task === 'water')).toMatchObject({ eligible: true, trigger: false });
    const hReports = await new SimRobot(humanoid, world).cycle();
    expect(hReports.find((r) => r.task === 'water')).toMatchObject({ outcome: 'skipped' });

    // Inspection with alert: localized message comes from the signed manifest, never the robot.
    await humanoid.syncClock();
    await humanoid.emit('oosr.observation.recorded', urn, { notify: { severity: 'warning', message_key: 'leaf_spots' } }, SKILL);
    const alerts = (await env.owner('GET', `/v0/objects/${urn}/state`)).body.open_alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ message_key: 'leaf_spots', messages: { es: 'Manchas en hojas, posible hongo' } });
    expect((await env.owner('POST', `/v0/objects/${urn}/alerts/leaf_spots/ack`)).status).toBe(200);
    expect((await env.owner('GET', `/v0/objects/${urn}/state`)).body.open_alerts).toEqual([]);

    // The log is the source of truth: a restarted hub derives the same projection.
    const reopened = Hub.open(env.dir);
    expect(reopened.getState(urn).last_watered).toBe(state.last_watered);
    expect(reopened.resolve('hub-7f3a', 'tag36h11', 37).object).toBe(urn);
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
    urn = await env.enrol(arm, 37, CONFIRM);
    await arm.syncClock();
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
    await humanoid.syncClock();
    await arm.emit('oosr.task.water.started', urn, { lease_s: 600 }, SKILL);
    await expectError(humanoid.emit('oosr.task.water.started', urn, { lease_s: 600 }, SKILL), 409, 'lease_conflict');
    // Only the lease holder can complete; completing releases the lease.
    await expectError(humanoid.emit('oosr.task.water.completed', urn, { volume_ml: 100 }, SKILL), 409, 'no_lease');
    await arm.emit('oosr.task.water.completed', urn, { volume_ml: 240 }, SKILL);
    await humanoid.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL);
  });

  it('rejects writes outside the robot scopes', async () => {
    const observer = await env.pairRobot(humanoidCapability(), { write: ['oosr.observation.*'] });
    await observer.syncClock();
    await observer.emit('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.3 } });
    await expectError(observer.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL), 403, 'scope_denied');
  });

  it('rejects writes outside the robot zones', async () => {
    const kitchenOnly = await env.pairRobot(humanoidCapability(), { zones: ['cocina'] });
    await kitchenOnly.syncClock();
    await expectError(kitchenOnly.emit('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.3 } }), 403, 'zone_denied');
  });

  it('rejects hub-only event types from robots', async () => {
    await expectError(arm.emit('oosr.approval.granted', urn, { approval_id: 'x' }), 403, 'hub_only_type');
  });

  it('rejects a task the robot is not eligible for (outside its primitives)', async () => {
    const vacuum = await env.pairRobot(vacuumCapability());
    await vacuum.syncClock();
    await expectError(vacuum.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL), 403, 'not_eligible');
  });

  it('requires a granted approval for sensitive tasks and consumes it', async () => {
    const bonsai: SkillManifest = {
      ...ficusManifest(),
      id: 'skill:vivero-x.es/bonsai-care',
      applies_to: ['plant/bonsai'],
      tasks: [{ name: 'prune', requires: ['inspect', 'cut'], requires_human_approval: true }],
    };
    await env.owner('POST', '/v0/skills', await env.sign(bonsai));
    const humanoid = await env.pairRobot(humanoidCapability());
    const tree = await env.enrol(humanoid, 12, { type: 'plant/bonsai', zone: 'salon', skills: [] });
    await humanoid.syncClock();
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
    const hedge: SkillManifest = {
      ...ficusManifest(),
      id: 'skill:vivero-x.es/hedge-care',
      applies_to: ['plant/hedge'],
      tasks: [{ name: 'trim', requires: ['cut'] }],
    };
    await env.owner('POST', '/v0/skills', await env.sign(hedge));
    const humanoid = await env.pairRobot(humanoidCapability());
    const h = await env.enrol(humanoid, 13, { type: 'plant/hedge', zone: 'salon', skills: [] });
    await humanoid.syncClock();
    await expectError(humanoid.emit('oosr.task.trim.started', h, {}, 'skill:vivero-x.es/hedge-care@1.2.0'), 403, 'approval_required');
  });

  it('rejects tasks out of season', async () => {
    const offMonth = String(((localMonth(new Date()) + 5) % 12) + 1).padStart(2, '0');
    const seasonal: SkillManifest = {
      ...ficusManifest(),
      id: 'skill:vivero-x.es/rose-care',
      applies_to: ['plant/rose'],
      tasks: [{ name: 'feed', season: [offMonth], requires: ['navigate_to'] }],
    };
    await env.owner('POST', '/v0/skills', await env.sign(seasonal));
    const rose = await env.enrol(arm, 14, { type: 'plant/rose', zone: 'salon', skills: [] });
    await expectError(arm.emit('oosr.task.feed.started', rose, {}, 'skill:vivero-x.es/rose-care@1.2.0'), 403, 'out_of_season');
  });

  it('rejects physical tasks during quiet hours', async () => {
    const policy = (await env.owner('GET', '/v0/policy')).body;
    const now = new Date();
    const hh = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    await env.owner('PUT', '/v0/policy', {
      ...policy,
      timezone: 'UTC',
      quiet_hours: { from: hh(new Date(now.getTime() - 3_600_000)), to: hh(new Date(now.getTime() + 3_600_000)) },
    });
    await expectError(arm.emit('oosr.task.water.started', urn, { lease_s: 60 }, SKILL), 403, 'quiet_hours');
    // Observations are not physical and still go through.
    await arm.emit('oosr.observation.recorded', urn, { measurements: { soil_moisture: 0.2 } });
  });

  it('a tag without binding executes nothing', async () => {
    await expectError(arm.resolve('hub-7f3a', 99), 404, 'unbound_tag');
    const ghost = 'urn:oosr:obj:hub-7f3a:0192f5e1-0000-7000-8000-000000000000';
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

describe('§5 skill trust', () => {
  let env: Env;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(() => env.close());

  it('refuses skills from untrusted publishers', async () => {
    const policy = (await env.owner('GET', '/v0/policy')).body;
    await env.owner('PUT', '/v0/policy', { ...policy, trusted_publishers: [] });
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
    const m = { ...ficusManifest(), id: 'skill:oosr.dev/ficus-lyrata-care' };
    await expect(env.sign(m)).rejects.toThrow(/namespace/);
  });

  it('falls back to the most specific skill by type when the object declares none', async () => {
    await env.owner('POST', '/v0/skills', await env.sign(ficusManifest()));
    const generic: SkillManifest = { ...ficusManifest(), id: 'skill:vivero-x.es/plant-care', applies_to: ['plant'] };
    await env.owner('POST', '/v0/skills', await env.sign(generic));
    const arm = await env.pairRobot(acmeCapability());
    const ficus = await env.enrol(arm, 40, { zone: 'salon', attributes: { pot_volume_l: 3 }, skills: [] });
    const other = await env.enrol(arm, 41, { type: 'plant/olea-europaea', zone: 'salon', attributes: { pot_volume_l: 3 }, skills: [] });
    expect(new Set((await arm.tasks(ficus)).map((t) => t.skill))).toEqual(new Set([`skill:vivero-x.es/ficus-lyrata-care@1.2.0`]));
    expect(new Set((await arm.tasks(other)).map((t) => t.skill))).toEqual(new Set([`skill:vivero-x.es/plant-care@1.2.0`]));
  });
});
