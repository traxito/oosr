import type { ObjectDescription, Step, Task } from './types.js';

export class ParamError extends Error {}

/** Standard instance attribute names that skills may rely on. */
export const ATTR = {
  potVolumeL: 'pot_volume_l',
  massKg: 'mass_kg',
} as const;

/**
 * Resolves a dispense volume against the object's attributes and clamps it to the task's
 * max_volume_ml. `{per_pot_litre: 80}` on a 3 l pot -> 240 ml.
 */
export function resolveVolumeMl(step: Step, task: Task, object: ObjectDescription): number {
  const spec = step.volume_ml;
  let ml: number;
  if (typeof spec === 'number') {
    ml = spec;
  } else if (spec && typeof spec === 'object' && 'per_pot_litre' in spec) {
    const litres = object.attributes?.[ATTR.potVolumeL];
    if (typeof litres !== 'number' || !(litres > 0)) {
      throw new ParamError(`object ${object.id} has no numeric attributes.${ATTR.potVolumeL}`);
    }
    ml = (spec as { per_pot_litre: number }).per_pot_litre * litres;
  } else {
    throw new ParamError('dispense step without volume_ml');
  }
  const max = task.constraints?.max_volume_ml;
  return Math.round(max !== undefined ? Math.min(ml, max) : ml);
}

/** Upper bound of a dispense step without an object, used for matching and publisher lint. */
export function dispenseUpperBoundMl(step: Step, task: Task): number | undefined {
  const max = task.constraints?.max_volume_ml;
  if (typeof step.volume_ml === 'number') return max !== undefined ? Math.min(step.volume_ml, max) : step.volume_ml;
  return max;
}
