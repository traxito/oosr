import { skillBelongsToPublisher } from './ids.js';
import { sha256Sri, signDetached, verifyDetached, type PrivateJwk, type PublicJwk } from './jws.js';
import { dispenseUpperBoundMl } from './params.js';
import { capabilityOfStep, isKnownCapability } from './primitives.js';
import { validate, type ValidationResult } from './schemas.js';
import type { SkillManifest, SkillPackage } from './types.js';

export const MANIFEST_FILE = 'manifest.json';

/**
 * Schema + semantic rules a publisher must pass. `signed: false` lints a source tree
 * before signing (no signature/integrity yet).
 */
export function lintSkill(manifest: SkillManifest, opts: { signed?: boolean } = {}): ValidationResult {
  const schema = validate('skill-manifest', manifest);
  if (!schema.valid) return schema;
  const errors: string[] = [];
  const messages = manifest.messages ?? {};

  if (!skillBelongsToPublisher(manifest.id, manifest.publisher)) {
    errors.push(`/id ${manifest.id} is outside the namespace of ${manifest.publisher}`);
  }
  const names = new Set<string>();
  manifest.tasks.forEach((task, i) => {
    const at = `/tasks/${i}`;
    if (names.has(task.name)) errors.push(`${at}/name duplicate task "${task.name}"`);
    names.add(task.name);
    for (const r of task.requires) if (!isKnownCapability(r)) errors.push(`${at}/requires unknown primitive "${r}"`);
    if (task.title_key && !messages[task.title_key]) errors.push(`${at}/title_key "${task.title_key}" not in messages`);
    for (const [j, step] of (task.steps ?? []).entries()) {
      const cap = capabilityOfStep(step);
      if (!task.requires.includes(cap)) errors.push(`${at}/steps/${j} uses "${cap}" which is not declared in requires`);
      if (step.p === 'notify_human' && !messages[step.message_key as string]) {
        errors.push(`${at}/steps/${j} message_key "${String(step.message_key)}" not in messages`);
      }
      if (step.p === 'dispense' && dispenseUpperBoundMl(step, task) === undefined) {
        errors.push(`${at}/steps/${j} dispense volume is unbounded: set constraints.max_volume_ml`);
      }
    }
  });

  if (opts.signed) {
    if (!manifest.signature) errors.push('/signature missing');
    else if (!manifest.signature.kid.startsWith(`${manifest.publisher}#`)) errors.push('/signature/kid does not belong to the publisher');
    if (manifest.knowledge && !manifest.integrity?.[manifest.knowledge]) errors.push(`/integrity missing hash for ${manifest.knowledge}`);
  }
  return { valid: errors.length === 0, errors };
}

/** The signature covers the canonical manifest without the signature member. */
export function signingPayload(manifest: SkillManifest): Omit<SkillManifest, 'signature'> {
  const { signature: _s, ...rest } = manifest;
  return rest;
}

export async function computeIntegrity(files: Record<string, Uint8Array>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) {
    if (path === MANIFEST_FILE) continue;
    out[path] = await sha256Sri(files[path]!);
  }
  return out;
}

export async function signSkill(
  manifest: SkillManifest,
  files: Record<string, Uint8Array>,
  key: PrivateJwk,
  kid: string,
): Promise<SkillManifest> {
  const integrity = await computeIntegrity(files);
  const body: SkillManifest = { ...signingPayload(manifest), ...(Object.keys(integrity).length ? { integrity } : {}) };
  const lint = lintSkill(body);
  if (!lint.valid) throw new Error(`skill does not lint:\n  ${lint.errors.join('\n  ')}`);
  if (!kid.startsWith(`${manifest.publisher}#`)) throw new Error(`kid ${kid} must belong to ${manifest.publisher}`);
  return { ...body, signature: { alg: 'ES256', kid, value: await signDetached(body, key, kid) } };
}

export type KeyResolver = (kid: string) => Promise<PublicJwk>;

/**
 * Verifies a transported package: schema, semantics, publisher namespace, signature and
 * that the file set is exactly what the manifest's integrity map says.
 */
export async function verifySkillPackage(pkg: SkillPackage, resolveKey: KeyResolver): Promise<void> {
  const { manifest } = pkg;
  const lint = lintSkill(manifest, { signed: true });
  if (!lint.valid) throw new Error(`invalid skill: ${lint.errors.join('; ')}`);
  const sig = manifest.signature!;
  const header = await verifyDetached(sig.value, signingPayload(manifest), await resolveKey(sig.kid));
  if (header.kid !== sig.kid) throw new Error('signature kid mismatch');

  const integrity = manifest.integrity ?? {};
  const files = Object.keys(pkg.files ?? {}).filter((p) => p !== MANIFEST_FILE);
  for (const path of files) {
    const expected = integrity[path];
    if (!expected) throw new Error(`file ${path} is not covered by integrity`);
    const actual = await sha256Sri(new Uint8Array(Buffer.from(pkg.files[path]!, 'base64')));
    if (actual !== expected) throw new Error(`integrity mismatch for ${path}`);
  }
  for (const path of Object.keys(integrity)) {
    if (!files.includes(path)) throw new Error(`file ${path} listed in integrity is missing`);
  }
}

/** Resolves a localized message from the manifest. Never falls back to robot-provided text. */
export function localizedMessage(manifest: Pick<SkillManifest, 'messages'>, key: string, langs: string[]): string | undefined {
  const entry = manifest.messages?.[key];
  if (!entry) return undefined;
  for (const l of [...langs, 'en']) {
    if (entry[l]) return entry[l];
    const base = l.split('-')[0]!;
    if (entry[base]) return entry[base];
  }
  return Object.values(entry)[0];
}
