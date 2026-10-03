import { matchTask, parseSkillRef, parseTaskType, verifyEvent, type OosrEvent } from '@oosr/core';
import type { Hub } from './hub.js';

export interface AuditCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface AuditReport {
  robot: string;
  ok: boolean;
  events: number;
  rejections: number;
  checks: AuditCheck[];
}

/** Refusals that a conformant robot avoids by checking before it writes. */
const VIOLATIONS = new Set([
  'invalid_event',
  'bad_signature',
  'source_mismatch',
  'id_conflict',
  'clock_skew',
  'hub_only_type',
  'scope_denied',
  'zone_denied',
  'not_eligible',
  'unknown_task',
  'skill_not_applicable',
  'out_of_season',
  'quiet_hours',
  'approval_required',
  'approval_mismatch',
  'no_lease',
  'notify_without_skill',
  'unknown_message_key',
]);

const MAX_LISTED = 5;
const list = (xs: string[]) => (xs.length > MAX_LISTED ? `${xs.slice(0, MAX_LISTED).join(', ')} … (+${xs.length - MAX_LISTED})` : xs.join(', '));

/**
 * Robot-role conformance (RFC-0001 §9): replays what a robot wrote, and what the hub refused,
 * against its capability manifest and the skills it acted under.
 */
export async function auditRobot(hub: Hub, robotUrn: string): Promise<AuditReport> {
  const record = hub.listRobots().find((r) => r.robot === robotUrn);
  const checks: AuditCheck[] = [];
  const add = (id: string, bad: string[], detail: string, warnOnly = false) =>
    checks.push({ id, status: bad.length ? (warnOnly ? 'warn' : 'fail') : 'pass', detail: bad.length ? `${detail}: ${list(bad)}` : detail });

  if (!record) {
    return { robot: robotUrn, ok: false, events: 0, rejections: 0, checks: [{ id: 'paired', status: 'fail', detail: 'robot was never paired with this hub' }] };
  }
  checks.push({
    id: 'capability_manifest',
    status: record.revoked_at ? 'warn' : 'pass',
    detail: record.revoked_at ? `published, but the robot was revoked at ${record.revoked_at}` : `published: ${record.capability.primitives.length} primitives`,
  });
  checks.push({
    id: 'device_certificate',
    status: record.device_attestation ? 'pass' : 'warn',
    detail: record.device_attestation ? `issued by ${record.device_attestation.iss}` : 'no manufacturer device certificate',
  });

  const events = hub.allEvents().filter((e) => e.source === robotUrn);

  const badSig: string[] = [];
  for (const ev of events) {
    try {
      await verifyEvent(ev, record.public_jwk);
    } catch {
      badSig.push(ev.id);
    }
  }
  add('events_signed', badSig, `${events.length} events verify with the paired key`);

  const ineligible: string[] = [];
  const overConstraint: string[] = [];
  const orphan: string[] = [];
  const implausible: string[] = [];
  const open = new Map<string, OosrEvent>();
  const limitMl = record.capability.limits?.dispense_max_ml;

  for (const ev of events) {
    for (const [k, v] of Object.entries((ev.data.measurements ?? {}) as Record<string, unknown>)) {
      if (k === 'soil_moisture' && typeof v === 'number' && (v < 0 || v > 1)) implausible.push(`${ev.id} soil_moisture=${v}`);
    }
    const tt = parseTaskType(ev.type);
    if (!tt) continue;
    const pkg = ev.oosrskill ? hub.findSkill(ev.oosrskill) : undefined;
    const task = pkg?.manifest.tasks.find((t) => t.name === tt.task);
    let object;
    try {
      object = hub.getObject(ev.subject);
    } catch {
      object = undefined;
    }
    if (!task || !object || !matchTask(task, record.capability, object).eligible) ineligible.push(`${ev.id} (${tt.task})`);

    const runKey = `${ev.subject}|${tt.task}`;
    if (tt.phase === 'started') open.set(runKey, ev);
    else {
      if (!open.has(runKey)) orphan.push(`${ev.id} (${tt.task}.${tt.phase})`);
      open.delete(runKey);
    }

    if (tt.phase === 'completed' && task) {
      const ml = ev.data.volume_ml;
      const max = task.constraints?.max_volume_ml;
      if (typeof ml === 'number' && ((max !== undefined && ml > max) || (limitMl !== undefined && ml > limitMl))) {
        overConstraint.push(`${ev.id} volume_ml=${ml} (max ${Math.min(max ?? Infinity, limitMl ?? Infinity)})`);
      }
      const removed = ev.data.foliage_removed;
      const maxRemoved = task.constraints?.max_foliage_removed;
      if (typeof removed === 'number' && maxRemoved !== undefined && removed > maxRemoved) {
        overConstraint.push(`${ev.id} foliage_removed=${removed} (max ${maxRemoved})`);
      }
    }
  }
  add('tasks_within_primitives', ineligible, 'every task event matches the capability manifest');
  add('constraints_respected', overConstraint, 'reported results stay within skill constraints and robot limits');
  add('runs_well_formed', orphan, 'every completed/failed follows a started by the same robot');
  add('measurements_plausible', implausible, 'measurements are within physical ranges');

  const rejections = hub.listRejections(robotUrn);
  const violations = rejections.filter((r) => VIOLATIONS.has(r.code)).map((r) => `${r.code}${r.type ? ` on ${r.type}` : ''}`);
  const races = rejections.filter((r) => !VIOLATIONS.has(r.code)).map((r) => r.code);
  add('no_refused_writes', violations, 'the hub never had to refuse a write that the robot could have checked first');
  add('no_races', races, 'no lease conflicts or writes against unknown objects or skills', true);

  // Approvals are referenced, not re-used: a consumed approval appearing twice is a violation.
  const approvalUses = new Map<string, number>();
  for (const ev of events) {
    const id = ev.data.approval_id;
    if (typeof id === 'string' && parseTaskType(ev.type)?.phase === 'started') approvalUses.set(id, (approvalUses.get(id) ?? 0) + 1);
  }
  add('approvals_single_use', [...approvalUses].filter(([, n]) => n > 1).map(([id]) => id), 'each approval is used at most once');

  const skills = new Set(events.map((e) => e.oosrskill).filter((s): s is string => !!s).map((s) => parseSkillRef(s).id));
  return {
    robot: robotUrn,
    ok: checks.every((c) => c.status !== 'fail'),
    events: events.length,
    rejections: rejections.length,
    checks: [...checks, { id: 'skills_used', status: 'pass', detail: [...skills].join(', ') || 'none' }],
  };
}
