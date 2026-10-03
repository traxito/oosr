export type Semver = [number, number, number];

export function parseSemver(v: string): Semver {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v);
  if (!m) throw new Error(`invalid version ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** Highest version >= min and on the same major line (a major bump requires re-approval). */
export function pickVersion(available: string[], min?: string): string | undefined {
  const sorted = [...available].sort(compareSemver).reverse();
  if (!min) return sorted[0];
  const [major] = parseSemver(min);
  return sorted.find((v) => parseSemver(v)[0] === major && compareSemver(v, min) >= 0);
}
