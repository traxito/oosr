import type { ConditionContext } from './conditions.js';
import { compareEvents, parseTaskType } from './events.js';
import type { OosrEvent, Sensor } from './types.js';

export interface Measurement {
  value: number;
  at: string;
  source: string;
}

export interface Alert {
  message_key: string;
  severity: 'info' | 'warning' | 'critical';
  skill?: string;
  at: string;
  source: string;
  event: string;
}

export interface TaskState {
  last_started?: string;
  last_completed?: string;
  last_failed?: string;
  last_result?: Record<string, unknown>;
}

/** Per-object projection derived from the log. Never written directly. */
export interface ObjectState {
  object: string;
  lamport: number;
  updated_at?: string;
  last_by_type: Record<string, string>;
  measurements: Partial<Record<Sensor, Measurement>>;
  tasks: Record<string, TaskState>;
  open_alerts: Alert[];
  /** Convenience alias of tasks.water.last_completed. */
  last_watered?: string;
}

const SENSORS: Sensor[] = ['soil_moisture', 'light_lux', 'temperature'];

export function emptyState(object: string): ObjectState {
  return { object, lamport: 0, last_by_type: {}, measurements: {}, tasks: {}, open_alerts: [] };
}

function record(state: ObjectState, sensor: Sensor, value: unknown, ev: OosrEvent): void {
  if (typeof value !== 'number') return;
  const prev = state.measurements[sensor];
  if (!prev || prev.at <= ev.time) state.measurements[sensor] = { value, at: ev.time, source: ev.source };
}

export function reduce(state: ObjectState, ev: OosrEvent): ObjectState {
  if (ev.subject !== state.object) return state;
  state.lamport = Math.max(state.lamport, ev.oosrlamport);
  state.updated_at = !state.updated_at || ev.time > state.updated_at ? ev.time : state.updated_at;
  state.last_by_type[ev.type] = ev.time > (state.last_by_type[ev.type] ?? '') ? ev.time : state.last_by_type[ev.type]!;
  const data = ev.data ?? {};

  const task = parseTaskType(ev.type);
  if (task) {
    const t = (state.tasks[task.task] ??= {});
    if (task.phase === 'started') t.last_started = ev.time;
    if (task.phase === 'failed') t.last_failed = ev.time;
    if (task.phase === 'completed') {
      t.last_completed = ev.time;
      t.last_result = data;
      for (const s of SENSORS) record(state, s, data[`${s}_after`], ev);
      if (task.task === 'water') state.last_watered = ev.time;
    }
    return state;
  }

  if (ev.type === 'oosr.observation.recorded') {
    const m = (data.measurements ?? {}) as Record<string, unknown>;
    for (const s of SENSORS) record(state, s, m[s], ev);
    const notify = data.notify as { severity: Alert['severity']; message_key: string } | undefined;
    if (notify && !state.open_alerts.some((a) => a.message_key === notify.message_key)) {
      state.open_alerts.push({
        message_key: notify.message_key,
        severity: notify.severity,
        ...(ev.oosrskill ? { skill: ev.oosrskill } : {}),
        at: ev.time,
        source: ev.source,
        event: ev.id,
      });
    }
  }
  if (ev.type === 'oosr.alert.acknowledged') {
    state.open_alerts = state.open_alerts.filter((a) => a.message_key !== data.message_key);
  }
  return state;
}

export function project(object: string, events: OosrEvent[]): ObjectState {
  return [...events].sort(compareEvents).reduce(reduce, emptyState(object));
}

/** Adapts a projection (plus fresh readings) to the condition evaluator. */
export function conditionContext(state: ObjectState, now: Date, fresh: Partial<Record<Sensor, number>> = {}): ConditionContext {
  return {
    now,
    lastEventTime: (type) => (state.last_by_type[type] ? new Date(state.last_by_type[type]!) : undefined),
    measurement: (s) => fresh[s] ?? state.measurements[s]?.value,
  };
}
