import type { HomePolicy } from '@oosr/core';

/** "oosr.task.water.*" matches "oosr.task.water.started"; "*" matches one or more segments at the end. */
export function typeMatchesGlob(type: string, glob: string): boolean {
  if (glob === type) return true;
  const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
  return re.test(type);
}

export function canWrite(policy: HomePolicy, robot: string, type: string): boolean {
  const globs = policy.robots?.[robot]?.write ?? [];
  return globs.some((g) => typeMatchesGlob(type, g));
}

export function zoneAllowed(policy: HomePolicy, robot: string, zone: string | undefined): boolean {
  const zones = policy.robots?.[robot]?.zones;
  if (!zones?.length) return true;
  return zone !== undefined && zones.includes(zone);
}

function localMinutes(date: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuietHours(policy: HomePolicy, now: Date): boolean {
  if (!policy.quiet_hours) return false;
  const t = localMinutes(now, policy.timezone);
  const from = toMinutes(policy.quiet_hours.from);
  const to = toMinutes(policy.quiet_hours.to);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

export const DEFAULT_ROBOT_WRITE = ['oosr.observation.*', 'oosr.task.*'];
