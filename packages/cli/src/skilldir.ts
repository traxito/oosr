import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MANIFEST_FILE, type SkillManifest, type SkillPackage } from '@oosr/core';

/** Reads a skill source directory: manifest.json plus every other non-hidden file. */
export function readSkillDir(dir: string): { manifest: SkillManifest; files: Record<string, Uint8Array> } {
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new Error(`${dir} has no ${MANIFEST_FILE}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SkillManifest;
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split(sep).join('/');
        if (rel !== MANIFEST_FILE) files[rel] = readFileSync(full);
      }
    }
  };
  walk(dir);
  return { manifest, files };
}

export function toPackage(manifest: SkillManifest, files: Record<string, Uint8Array>): SkillPackage {
  return {
    manifest,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])),
  };
}
