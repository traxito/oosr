import { canonicalBytes } from './jcs.js';

/**
 * ES256 detached JWS (RFC 7515 Appendix F) over the JCS form of a JSON value.
 * Serialized as `<protected>..<signature>`: the payload is never transported twice.
 */

export type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid?: string };
export type PrivateJwk = PublicJwk & { d: string };

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return buf.toString('base64url');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export async function generateKeyPair(kid?: string): Promise<{ privateJwk: PrivateJwk; publicJwk: PublicJwk }> {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const privateJwk: PrivateJwk = { kty: 'EC', crv: 'P-256', x: priv.x!, y: priv.y!, d: priv.d!, ...(kid ? { kid } : {}) };
  return { privateJwk, publicJwk: toPublicJwk(privateJwk) };
}

export function toPublicJwk(jwk: PublicJwk | PrivateJwk): PublicJwk {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ...(jwk.kid ? { kid: jwk.kid } : {}) };
}

export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  // RFC 7638: required members in lexicographic order.
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))));
}

function importKey(jwk: PublicJwk | PrivateJwk, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const { kid: _kid, ...material } = jwk;
  const keyData = usage === 'verify' ? toPublicJwk(material as PublicJwk) : material;
  return crypto.subtle.importKey('jwk', { ...keyData, ext: true } as JsonWebKey, ALG, false, [usage]);
}

function signingInput(protectedB64: string, payload: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${protectedB64}.${b64url(canonicalBytes(payload))}`);
}

export async function signDetached(payload: unknown, privateJwk: PrivateJwk, kid: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid }));
  const key = await importKey(privateJwk, 'sign');
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, key, signingInput(header, payload)));
  return `${header}..${b64url(sig)}`;
}

export interface JwsHeader {
  alg: string;
  kid: string;
}

export function parseDetached(jws: string): { header: JwsHeader; protectedB64: string; signature: Uint8Array<ArrayBuffer> } {
  const m = /^([A-Za-z0-9_-]+)\.\.([A-Za-z0-9_-]+)$/.exec(jws);
  if (!m) throw new Error('malformed detached JWS');
  const header = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as JwsHeader;
  if (header.alg !== 'ES256') throw new Error(`unsupported alg ${header.alg}`);
  if (typeof header.kid !== 'string' || !header.kid) throw new Error('JWS header without kid');
  return { header, protectedB64: m[1]!, signature: fromB64url(m[2]!) };
}

/** Returns the header on success, throws on any failure. */
export async function verifyDetached(jws: string, payload: unknown, publicJwk: PublicJwk): Promise<JwsHeader> {
  const { header, protectedB64, signature } = parseDetached(jws);
  const key = await importKey(publicJwk, 'verify');
  const ok = await crypto.subtle.verify(SIGN, key, signature, signingInput(protectedB64, payload));
  if (!ok) throw new Error('invalid signature');
  return header;
}

export async function sha256Sri(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return `sha256-${Buffer.from(digest).toString('base64')}`;
}

/** Compact (non-detached) JWS, used for device certificates where the payload travels with the signature. */
export async function signCompact(payload: unknown, privateJwk: PrivateJwk, kid: string, typ?: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid, ...(typ ? { typ } : {}) }));
  const body = b64url(JSON.stringify(payload));
  const key = await importKey(privateJwk, 'sign');
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${b64url(sig)}`;
}

export function decodeCompact<T>(jws: string): { header: JwsHeader & { typ?: string }; payload: T } {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error('malformed compact JWS');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as JwsHeader & { typ?: string };
  if (header.alg !== 'ES256') throw new Error(`unsupported alg ${header.alg}`);
  if (typeof header.kid !== 'string' || !header.kid) throw new Error('JWS header without kid');
  return { header, payload: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as T };
}

export async function verifyCompact<T>(jws: string, publicJwk: PublicJwk): Promise<{ header: JwsHeader & { typ?: string }; payload: T }> {
  const decoded = decodeCompact<T>(jws);
  const [h, p, s] = jws.split('.');
  const key = await importKey(publicJwk, 'verify');
  const ok = await crypto.subtle.verify(SIGN, key, fromB64url(s!), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('invalid signature');
  return decoded;
}
