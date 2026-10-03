import type { PublicJwk } from './jws.js';

export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: { id: string; type: 'JsonWebKey2020'; controller: string; publicKeyJwk: PublicJwk }[];
  assertionMethod: string[];
  service?: { id: string; type: string; serviceEndpoint: string }[];
}

/** DID service type a publisher uses to announce its skill registry. */
export const SKILL_REGISTRY_SERVICE = 'OOSRSkillRegistry';

/** did:web:example.com -> https://example.com/.well-known/did.json; path segments map to path. */
export function didWebUrl(did: string): string {
  if (!did.startsWith('did:web:')) throw new Error(`not a did:web: ${did}`);
  const [host, ...path] = did.slice('did:web:'.length).split(':');
  const base = `https://${decodeURIComponent(host!)}`;
  return path.length ? `${base}/${path.map(decodeURIComponent).join('/')}/did.json` : `${base}/.well-known/did.json`;
}

export function buildDidDocument(
  did: string,
  keys: { fragment: string; jwk: PublicJwk }[],
  registry?: string,
): DidDocument {
  const methods = keys.map(({ fragment, jwk }) => ({
    id: `${did}#${fragment}`,
    type: 'JsonWebKey2020' as const,
    controller: did,
    publicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  }));
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: did,
    verificationMethod: methods,
    assertionMethod: methods.map((m) => m.id),
    ...(registry ? { service: [{ id: `${did}#skills`, type: SKILL_REGISTRY_SERVICE, serviceEndpoint: registry }] } : {}),
  };
}

export function findService(doc: DidDocument, type: string): string | undefined {
  return doc.service?.find((s) => s.type === type)?.serviceEndpoint;
}

export function findAssertionKey(doc: DidDocument, kid: string): PublicJwk {
  if (!doc.assertionMethod?.includes(kid)) throw new Error(`${kid} is not an assertion method of ${doc.id}`);
  const vm = doc.verificationMethod?.find((m) => m.id === kid);
  if (!vm?.publicKeyJwk) throw new Error(`${kid} not found in ${doc.id}`);
  return vm.publicKeyJwk;
}

export async function resolveDidWeb(did: string, fetchImpl: typeof fetch = fetch): Promise<DidDocument> {
  const res = await fetchImpl(didWebUrl(did), { headers: { accept: 'application/did+json, application/json' } });
  if (!res.ok) throw new Error(`did:web resolution failed for ${did}: HTTP ${res.status}`);
  const doc = (await res.json()) as DidDocument;
  if (doc.id !== did) throw new Error(`DID document id ${doc.id} does not match ${did}`);
  return doc;
}
