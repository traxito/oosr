import { randomBytes } from 'node:crypto';

/** UUIDv7 (RFC 9562): 48-bit ms timestamp, then random. Sortable, generated offline. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const OBJECT_URN = /^urn:oosr:obj:([a-z0-9-]+):([0-9a-f-]{36})$/;
export const ROBOT_URN = /^urn:oosr:robot:([a-z0-9-]+):([A-Za-z0-9._-]+)$/;
export const HUB_URN = /^urn:oosr:hub:([a-z0-9-]+)$/;

export function objectUrn(authority: string, id: string = uuidv7()): string {
  return `urn:oosr:obj:${authority}:${id}`;
}

export function isObjectUrn(s: string): boolean {
  return OBJECT_URN.test(s);
}

/** "skill:vivero-x.es/ficus-lyrata-care@1.2.0" -> { id, version } */
export function parseSkillRef(ref: string): { id: string; version: string | undefined } {
  const at = ref.lastIndexOf('@');
  return at > 0 ? { id: ref.slice(0, at), version: ref.slice(at + 1) } : { id: ref, version: undefined };
}

/**
 * The skill id authority must be the publisher's did:web identifier, so a publisher cannot
 * mint skills under someone else's namespace.
 *   did:web:vivero-x.es           -> skill:vivero-x.es/<name>
 *   did:web:traxito.github.io:oosr -> skill:traxito.github.io/oosr/<name>
 */
export function skillNamespace(publisherDid: string): string {
  if (!publisherDid.startsWith('did:web:')) throw new Error(`not a did:web: ${publisherDid}`);
  const [host, ...path] = publisherDid.slice('did:web:'.length).split(':');
  return `skill:${[decodeURIComponent(host!), ...path].join('/')}/`;
}

export function skillBelongsToPublisher(skillId: string, publisherDid: string): boolean {
  const ns = skillNamespace(publisherDid);
  return skillId.startsWith(ns) && !skillId.slice(ns.length).includes('/');
}

/** Inverse of skillNamespace: skill:traxito.github.io/oosr/x -> did:web:traxito.github.io:oosr */
export function publisherOfSkill(skillId: string): string {
  const m = /^skill:(.+)\/[a-z0-9-]+$/.exec(skillId);
  if (!m) throw new Error(`invalid skill id ${skillId}`);
  const [host, ...path] = m[1]!.split('/');
  return `did:web:${[host!.replace(/:/g, '%3A'), ...path].join(':')}`;
}

/** "skill:vivero-x.es/ficus-lyrata-care" -> "ficus-lyrata-care" */
export function skillName(skillId: string): string {
  return skillId.slice(skillId.lastIndexOf('/') + 1);
}
