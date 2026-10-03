import {
  SKILL_REGISTRY_SERVICE,
  findAssertionKey,
  findService,
  publisherOfSkill,
  resolveDidWeb,
  skillName,
  type DidDocument,
  type PublicJwk,
  type SkillPackage,
} from '@oosr/core';

export interface RegistryIndex {
  publisher: string;
  skills: { id: string; title?: string; applies_to: string[]; versions: string[]; latest: string }[];
}

/**
 * Resolves did:web keys of publishers and manufacturers: pinned keys first (offline,
 * local-first), then did:web with a cache. Also fetches skill packages from the registry a
 * publisher announces in its DID document.
 */
export class TrustResolver {
  private cache = new Map<string, { doc: DidDocument; at: number }>();

  constructor(
    private readonly pinned: () => Record<string, PublicJwk>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 3_600_000,
  ) {}

  async key(kid: string): Promise<PublicJwk> {
    const pinned = this.pinned()[kid];
    if (pinned) return pinned;
    const did = kid.split('#')[0]!;
    return findAssertionKey(await this.doc(did), kid);
  }

  async doc(did: string): Promise<DidDocument> {
    const hit = this.cache.get(did);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.doc;
    const doc = await resolveDidWeb(did, this.fetchImpl);
    this.cache.set(did, { doc, at: Date.now() });
    return doc;
  }

  async registry(did: string): Promise<string> {
    const endpoint = findService(await this.doc(did), SKILL_REGISTRY_SERVICE);
    if (!endpoint) throw new Error(`${did} does not announce an ${SKILL_REGISTRY_SERVICE} service`);
    return endpoint.replace(/\/$/, '');
  }

  async index(did: string): Promise<RegistryIndex> {
    return this.getJson<RegistryIndex>(`${await this.registry(did)}/index.json`);
  }

  async fetchPackage(skillId: string, version?: string): Promise<SkillPackage> {
    const did = publisherOfSkill(skillId);
    const base = await this.registry(did);
    let v = version;
    if (!v) {
      const entry = (await this.index(did)).skills.find((s) => s.id === skillId);
      if (!entry) throw new Error(`${skillId} not found in the registry of ${did}`);
      v = entry.latest;
    }
    return this.getJson<SkillPackage>(`${base}/${skillName(skillId)}/${v}.json`);
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
