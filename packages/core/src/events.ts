import { uuidv7 } from './ids.js';
import { signDetached, verifyDetached, type PrivateJwk, type PublicJwk } from './jws.js';
import type { OosrEvent, UnsignedEvent } from './types.js';

export interface EventInit<D> {
  source: string;
  type: string;
  subject: string;
  data: D;
  lamport: number;
  skill?: string;
  time?: Date;
  id?: string;
}

export function buildEvent<D extends Record<string, unknown>>(init: EventInit<D>): UnsignedEvent<D> {
  const time = init.time ?? new Date();
  return {
    specversion: '1.0',
    id: init.id ?? uuidv7(time.getTime()),
    source: init.source,
    type: init.type,
    subject: init.subject,
    time: time.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    datacontenttype: 'application/json',
    ...(init.skill ? { oosrskill: init.skill } : {}),
    oosrlamport: init.lamport,
    data: init.data,
  };
}

export function unsigned<D>(event: OosrEvent<D>): UnsignedEvent<D> {
  const { oosrsig: _sig, ...rest } = event;
  return rest;
}

export async function signEvent<D>(event: UnsignedEvent<D>, key: PrivateJwk, kid: string): Promise<OosrEvent<D>> {
  return { ...event, oosrsig: await signDetached(event, key, kid) };
}

export async function verifyEvent(event: OosrEvent, key: PublicJwk): Promise<string> {
  const header = await verifyDetached(event.oosrsig, unsigned(event), key);
  return header.kid;
}

/** "oosr.task.water.started" -> { task: "water", phase: "started" } */
export function parseTaskType(type: string): { task: string; phase: 'started' | 'completed' | 'failed' } | undefined {
  const m = /^oosr\.task\.([a-z][a-z0-9_]*)\.(started|completed|failed)$/.exec(type);
  return m ? { task: m[1]!, phase: m[2] as 'started' | 'completed' | 'failed' } : undefined;
}

/** Total order for merging logs from several writers: (lamport, source, id). */
export function compareEvents(a: OosrEvent, b: OosrEvent): number {
  return a.oosrlamport - b.oosrlamport || a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
}
