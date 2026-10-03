import { ROBOT_URN } from './ids.js';
import { decodeCompact, jwkThumbprint, signCompact, verifyCompact, type PrivateJwk, type PublicJwk } from './jws.js';

export const DEVICE_CERT_TYP = 'oosr-device+jwt';

/**
 * Device certificate: a compact JWS issued by the manufacturer's did:web key that binds the
 * robot URN and model to the robot's attestation key (RFC 7800 `cnf`).
 */
export interface DeviceCertClaims {
  /** Manufacturer DID, e.g. did:web:acme.example */
  iss: string;
  /** Robot URN, e.g. urn:oosr:robot:acme:sn-88412 */
  sub: string;
  model: string;
  cnf: { jwk: PublicJwk };
  /** Where the manufacturer asserts the private key lives. */
  key_storage?: 'tpm' | 'secure_element' | 'software';
  iat: number;
  exp?: number;
}

export interface DeviceAttestation {
  iss: string;
  key_storage?: DeviceCertClaims['key_storage'];
  verified_at: string;
}

export async function issueDeviceCert(
  claims: Omit<DeviceCertClaims, 'iat'> & { iat?: number },
  manufacturerKey: PrivateJwk,
  kid: string,
): Promise<string> {
  if (!kid.startsWith(`${claims.iss}#`)) throw new Error(`kid ${kid} does not belong to ${claims.iss}`);
  const { kid: _k, ...jwk } = claims.cnf.jwk;
  const body: DeviceCertClaims = { ...claims, cnf: { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } }, iat: claims.iat ?? Math.floor(Date.now() / 1000) };
  return signCompact(body, manufacturerKey, kid, DEVICE_CERT_TYP);
}

export interface DeviceCertExpectations {
  robot: string;
  model: string;
  publicJwk: PublicJwk;
  /** URN vendor segment -> manufacturer DID trusted by this household. */
  manufacturers: Record<string, string>;
  now?: Date;
}

/** Throws with a precise reason, or returns the verified claims. */
export async function verifyDeviceCert(
  cert: string,
  resolveKey: (kid: string) => Promise<PublicJwk>,
  expect: DeviceCertExpectations,
): Promise<DeviceCertClaims> {
  const { header, payload } = decodeCompact<DeviceCertClaims>(cert);
  if (header.typ !== DEVICE_CERT_TYP) throw new Error(`typ must be ${DEVICE_CERT_TYP}`);
  const vendor = ROBOT_URN.exec(expect.robot)?.[1];
  const trustedIssuer = vendor ? expect.manufacturers[vendor] : undefined;
  if (!trustedIssuer) throw new Error(`no trusted manufacturer for vendor "${vendor}"`);
  if (payload.iss !== trustedIssuer) throw new Error(`issuer ${payload.iss} is not the trusted manufacturer ${trustedIssuer}`);
  if (!header.kid.startsWith(`${payload.iss}#`)) throw new Error('kid does not belong to the issuer');

  await verifyCompact(cert, await resolveKey(header.kid));

  if (payload.sub !== expect.robot) throw new Error(`certificate is for ${payload.sub}, not ${expect.robot}`);
  if (payload.model !== expect.model) throw new Error(`certificate is for model ${payload.model}, not ${expect.model}`);
  if (!payload.cnf?.jwk || (await jwkThumbprint(payload.cnf.jwk)) !== (await jwkThumbprint(expect.publicJwk))) {
    throw new Error('certificate does not bind the key presented by the robot');
  }
  const now = Math.floor((expect.now ?? new Date()).getTime() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('certificate issued in the future');
  if (payload.exp !== undefined && payload.exp < now) throw new Error('certificate expired');
  return payload;
}
