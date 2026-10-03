import {
  conditionContext,
  evaluate,
  evaluateAll,
  resolveVolumeMl,
  type ObjectDescription,
  type ObjectState,
  type Sensor,
  type SkillManifest,
  type Step,
  type Task,
} from '@oosr/core';
import { ClientError, type RobotClient, type TaskView } from './client.js';

/** Simulated physical world: what the robot's sensors would read at each tag. */
export interface SimWorld {
  tags: Record<
    string,
    {
      soil_moisture?: number;
      light_lux?: number;
      temperature?: number;
      leaf_spots?: boolean;
    }
  >;
}

export type Log = (line: string) => void;

export interface RunReport {
  object: string;
  task: string;
  outcome: 'completed' | 'failed' | 'skipped' | 'awaiting_approval' | 'lease_conflict';
  detail?: string;
}

/** Moisture gain per ml of water per litre of pot; matches the RFC example (240 ml in 3 l: 0.12 -> 0.38). */
const MOISTURE_PER_ML_PER_L = 3.25 / 1000;

/**
 * A deterministic executor: it runs a task's declared steps, nothing else. It is what a real
 * robot's OOSR layer does before handing primitives to its own motion stack.
 */
export class SimRobot {
  constructor(
    readonly client: RobotClient,
    readonly world: SimWorld,
    private readonly log: Log = () => {},
    private readonly opts: { leaseS?: number } = {},
  ) {}

  private reading(tag: number | undefined, sensor: Sensor): number | undefined {
    if (tag === undefined) return undefined;
    return this.world.tags[String(tag)]?.[sensor];
  }

  private tagOf(object: ObjectDescription): number | undefined {
    return object.bindings?.[0]?.tag_id;
  }

  /** One scheduler pass over every object the hub knows. */
  async cycle(): Promise<RunReport[]> {
    await this.client.syncClock();
    const reports: RunReport[] = [];
    for (const object of await this.client.objects()) {
      for (const view of await this.client.tasks(object.id)) {
        if (!view.eligible || !view.in_season) continue;
        reports.push(await this.consider(object, object.state, view));
      }
    }
    return reports;
  }

  async consider(object: ObjectDescription, state: ObjectState, view: TaskView): Promise<RunReport> {
    const base = { object: object.id, task: view.task };
    if (view.lease && view.lease.robot !== this.client.robot) return { ...base, outcome: 'lease_conflict', detail: `leased by ${view.lease.robot}` };
    if (view.trigger === false) return { ...base, outcome: 'skipped', detail: 'trigger not met' };

    const pkg = await this.client.skill(view.skill);
    const manifest = pkg.manifest;
    const task = manifest.tasks.find((t) => t.name === view.task)!;
    const tag = this.tagOf(object);

    // Resolve unknowns with fresh, non-physical measurements before reserving anything.
    const fresh: Partial<Record<Sensor, number>> = {};
    for (const s of view.sensors as Sensor[]) {
      if (!this.client.capability.primitives.includes(`measure:${s}`)) continue;
      const v = this.reading(tag, s);
      if (v !== undefined) fresh[s] = v;
    }
    if (Object.keys(fresh).length) {
      await this.client.emit('oosr.observation.recorded', object.id, { measurements: fresh }, view.skill);
      this.log(`  measured ${JSON.stringify(fresh)} at ${object.name ?? object.id}`);
    }
    const ctx = conditionContext(state, new Date(), fresh);
    if (task.trigger && evaluate(task.trigger, ctx) !== true) return { ...base, outcome: 'skipped', detail: 'trigger not met' };
    if (evaluateAll(task.preconditions, ctx) !== true) return { ...base, outcome: 'skipped', detail: 'preconditions not met' };

    let approvalId: string | undefined;
    if (view.needs_approval) {
      const a = await this.client.requestApproval(object.id, view.skill, view.task);
      if (a.status !== 'granted') {
        this.log(`  ${view.task} needs human approval (${a.id}); waiting`);
        return { ...base, outcome: 'awaiting_approval', detail: a.id };
      }
      approvalId = a.id;
    }
    return this.execute(object, manifest, task, view.skill, approvalId);
  }

  async execute(object: ObjectDescription, manifest: SkillManifest, task: Task, skillRef: string, approvalId?: string): Promise<RunReport> {
    const base = { object: object.id, task: task.name };
    const tag = this.tagOf(object);
    try {
      await this.client.emit(
        `oosr.task.${task.name}.started`,
        object.id,
        { lease_s: this.opts.leaseS ?? 600, ...(approvalId ? { approval_id: approvalId } : {}) },
        skillRef,
      );
    } catch (e) {
      if (e instanceof ClientError && e.code === 'lease_conflict') return { ...base, outcome: 'lease_conflict', detail: e.message };
      throw e;
    }
    this.log(`  ${task.name}.started on ${object.name ?? object.id}`);

    const result: Record<string, unknown> = {};
    const firstReading: Partial<Record<Sensor, number>> = {};
    try {
      for (const step of task.steps ?? []) {
        await this.step(step, object, manifest, task, skillRef, tag, result, firstReading);
      }
      await this.client.emit(`oosr.task.${task.name}.completed`, object.id, result, skillRef);
      this.log(`  ${task.name}.completed ${JSON.stringify(result)}`);
      return { ...base, outcome: 'completed', detail: JSON.stringify(result) };
    } catch (e) {
      const reason = (e as Error).message;
      await this.client.emit(`oosr.task.${task.name}.failed`, object.id, { code: 'execution_error', reason }, skillRef).catch(() => {});
      this.log(`  ${task.name}.failed: ${reason}`);
      return { ...base, outcome: 'failed', detail: reason };
    }
  }

  private async step(
    step: Step,
    object: ObjectDescription,
    manifest: SkillManifest,
    task: Task,
    skillRef: string,
    tag: number | undefined,
    result: Record<string, unknown>,
    firstReading: Partial<Record<Sensor, number>>,
  ): Promise<void> {
    switch (step.p) {
      case 'navigate_to':
        this.log(`    navigate_to ${object.location?.zone ?? '?'} (standoff ${step.standoff_m ?? 0} m), refine pose with tag #${tag}`);
        return;
      case 'measure': {
        const sensor = step.sensor as Sensor;
        const v = this.reading(tag, sensor);
        if (v === undefined) throw new Error(`no ${sensor} reading at tag ${tag}`);
        if (firstReading[sensor] === undefined) {
          firstReading[sensor] = v;
          result[`${sensor}_before`] = v;
        } else {
          result[`${sensor}_after`] = v;
        }
        this.log(`    measure ${sensor} = ${v}${step.after_s ? ` (after ${step.after_s} s)` : ''}`);
        return;
      }
      case 'dispense': {
        let ml = resolveVolumeMl(step, task, object);
        const max = this.client.capability.limits?.dispense_max_ml;
        if (max !== undefined) ml = Math.min(ml, max);
        const litres = Number(object.attributes?.pot_volume_l ?? 1);
        const cell = (this.world.tags[String(tag)] ??= {});
        cell.soil_moisture = Math.min(0.6, Math.round(((cell.soil_moisture ?? 0) + (ml * MOISTURE_PER_ML_PER_L) / litres) * 100) / 100);
        result.volume_ml = ml;
        this.log(`    dispense ${step.liquid} ${ml} ml`);
        return;
      }
      case 'inspect': {
        const spots = this.world.tags[String(tag)]?.leaf_spots === true;
        result.findings = spots ? ['leaf_spots'] : [];
        this.log(`    inspect ${(step.aspects as string[]).join(', ')}: ${spots ? 'leaf spots found' : 'healthy'}`);
        if (spots && manifest.messages?.leaf_spots && this.client.capability.primitives.includes('notify_human')) {
          await this.client.emit('oosr.observation.recorded', object.id, { notify: { severity: 'warning', message_key: 'leaf_spots' } }, skillRef);
        }
        return;
      }
      case 'notify_human':
        await this.client.emit(
          'oosr.observation.recorded',
          object.id,
          { notify: { severity: step.severity, message_key: step.message_key } },
          skillRef,
        );
        return;
      default:
        // grasp, place, cut: the simulator has no physics; a real robot hands these to its motion stack.
        this.log(`    ${step.p} ${JSON.stringify(Object.fromEntries(Object.entries(step).filter(([k]) => k !== 'p')))}`);
    }
  }
}
