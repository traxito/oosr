import type { Step } from './types.js';

export interface PrimitiveSpec {
  /** Has a physical effect on the world: requires a lease and is subject to quiet hours. */
  physical: boolean;
  /** Parameter that qualifies the capability string, e.g. measure:soil_moisture. */
  qualifier?: string;
}

/** OOSR primitive vocabulary v0. New primitives enter by RFC, always optional. */
export const PRIMITIVES: Record<string, PrimitiveSpec> = {
  navigate_to: { physical: false },
  inspect: { physical: false },
  measure: { physical: false, qualifier: 'sensor' },
  grasp: { physical: true },
  place: { physical: true },
  dispense: { physical: true, qualifier: 'liquid' },
  cut: { physical: true },
  notify_human: { physical: false },
};

export function primitiveOf(capability: string): string {
  return capability.split(':')[0]!;
}

export function isKnownCapability(capability: string): boolean {
  const [p, q] = capability.split(':');
  const spec = PRIMITIVES[p!];
  if (!spec) return false;
  return q === undefined || spec.qualifier !== undefined;
}

export function isPhysical(capability: string): boolean {
  return PRIMITIVES[primitiveOf(capability)]?.physical ?? false;
}

/** Capability string a step needs, e.g. {p: measure, sensor: soil_moisture} -> measure:soil_moisture. */
export function capabilityOfStep(step: Step): string {
  const spec = PRIMITIVES[step.p];
  if (!spec) throw new Error(`unknown primitive ${step.p}`);
  const q = spec.qualifier ? step[spec.qualifier] : undefined;
  return typeof q === 'string' ? `${step.p}:${q}` : step.p;
}

/**
 * A required capability is satisfied when:
 *  - "p"   by robot "p" or any "p:q"
 *  - "p:q" only by robot "p:q" (a qualifier names concrete hardware: a soil probe, a water tank)
 */
export function satisfies(robotPrimitives: string[], required: string): boolean {
  if (required.includes(':')) return robotPrimitives.includes(required);
  return robotPrimitives.some((c) => c === required || c.startsWith(`${required}:`));
}
