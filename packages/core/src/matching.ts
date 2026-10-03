import { ATTR, dispenseUpperBoundMl, resolveVolumeMl } from './params.js';
import { capabilityOfStep, isPhysical, primitiveOf, satisfies } from './primitives.js';
import type { CapabilityManifest, HomePolicy, ObjectDescription, SkillManifest, Task } from './types.js';

export interface MatchResult {
  task: string;
  eligible: boolean;
  /** Required capabilities the robot does not declare. */
  missing: string[];
  /** Robot limits a parameter would exceed, e.g. "dispense_max_ml". */
  exceeded: string[];
}

/** Declared requires plus whatever the steps actually use. */
export function effectiveRequires(task: Task): string[] {
  const set = new Set(task.requires);
  for (const step of task.steps ?? []) set.add(capabilityOfStep(step));
  return [...set];
}

export function taskIsPhysical(task: Task): boolean {
  return effectiveRequires(task).some(isPhysical);
}

export function taskNeedsApproval(task: Task, policy?: Pick<HomePolicy, 'always_require_approval'>): boolean {
  if (task.requires_human_approval) return true;
  const always = policy?.always_require_approval ?? [];
  return effectiveRequires(task).some((c) => always.includes(c) || always.includes(primitiveOf(c)));
}

/**
 * Deterministic, runs before any planner: a task is eligible for a robot if every required
 * capability is declared and no parameter exceeds the robot's limits.
 */
export function matchTask(task: Task, cap: CapabilityManifest, object?: ObjectDescription): MatchResult {
  const missing = effectiveRequires(task).filter((r) => !satisfies(cap.primitives, r));
  const exceeded = new Set<string>();
  const limits = cap.limits ?? {};

  for (const step of task.steps ?? []) {
    if (step.p === 'dispense' && limits.dispense_max_ml !== undefined) {
      let ml: number | undefined;
      try {
        ml = object ? resolveVolumeMl(step, task, object) : dispenseUpperBoundMl(step, task);
      } catch {
        ml = dispenseUpperBoundMl(step, task);
      }
      if (ml === undefined || ml > limits.dispense_max_ml) exceeded.add('dispense_max_ml');
    }
  }
  const mass = object?.attributes?.[ATTR.massKg];
  if (typeof mass === 'number' && limits.payload_kg !== undefined && effectiveRequires(task).some((c) => primitiveOf(c) === 'grasp')) {
    if (mass > limits.payload_kg) exceeded.add('payload_kg');
  }

  return { task: task.name, eligible: missing.length === 0 && exceeded.size === 0, missing, exceeded: [...exceeded] };
}

export function matchSkill(manifest: SkillManifest, cap: CapabilityManifest, object?: ObjectDescription): MatchResult[] {
  return manifest.tasks.map((t) => matchTask(t, cap, object));
}

/** Hierarchical type match: a skill for "plant" applies to "plant/ficus-lyrata". */
export function typeMatches(appliesTo: string, objectType: string): boolean {
  return objectType === appliesTo || objectType.startsWith(`${appliesTo}/`);
}

/** Specificity of the best applies_to entry, -1 when the skill does not apply. */
export function typeSpecificity(manifest: Pick<SkillManifest, 'applies_to'>, objectType: string): number {
  return Math.max(-1, ...manifest.applies_to.filter((a) => typeMatches(a, objectType)).map((a) => a.split('/').length));
}
