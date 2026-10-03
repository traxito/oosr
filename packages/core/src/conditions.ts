import type { Condition, Sensor, Task } from './types.js';

/** Three-valued: undefined means "unknown until the robot measures". */
export type Tri = boolean | undefined;

export interface ConditionContext {
  now: Date;
  lastEventTime(type: string): Date | undefined;
  measurement(sensor: Sensor): number | undefined;
}

const DAY_MS = 86_400_000;

export function evaluate(c: Condition, ctx: ConditionContext): Tri {
  if ('any' in c) {
    const r = c.any.map((x) => evaluate(x, ctx));
    if (r.includes(true)) return true;
    return r.every((x) => x === false) ? false : undefined;
  }
  if ('all' in c) {
    const r = c.all.map((x) => evaluate(x, ctx));
    if (r.includes(false)) return false;
    return r.every((x) => x === true) ? true : undefined;
  }
  if ('since_event' in c) {
    const last = ctx.lastEventTime(c.since_event);
    // Never happened counts as infinitely long ago.
    if (!last) return true;
    return (ctx.now.getTime() - last.getTime()) / DAY_MS > c.gt_days;
  }
  const v = ctx.measurement(c.measure);
  if (v === undefined) return undefined;
  if (c.lt !== undefined && !(v < c.lt)) return false;
  if (c.gt !== undefined && !(v > c.gt)) return false;
  return true;
}

export function evaluateAll(conds: Condition[] | undefined, ctx: ConditionContext): Tri {
  if (!conds?.length) return true;
  return evaluate({ all: conds }, ctx);
}

/** Sensors a condition reads, so a robot knows what to measure to resolve "unknown". */
export function sensorsOf(c: Condition | undefined): Sensor[] {
  if (!c) return [];
  if ('any' in c) return [...new Set(c.any.flatMap(sensorsOf))];
  if ('all' in c) return [...new Set(c.all.flatMap(sensorsOf))];
  if ('measure' in c) return [c.measure];
  return [];
}

/** Local month (01-12) in a time zone. */
export function localMonth(date: Date, timeZone?: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone }).format(date));
}

/** Seasons in skills are written for the northern hemisphere. */
export function inSeason(task: Task, date: Date, opts: { hemisphere?: 'north' | 'south'; timeZone?: string } = {}): boolean {
  if (!task.season?.length) return true;
  let month = localMonth(date, opts.timeZone);
  if (opts.hemisphere === 'south') month = ((month + 5) % 12) + 1;
  return task.season.includes(String(month).padStart(2, '0'));
}
