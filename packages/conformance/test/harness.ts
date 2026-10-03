import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  generateKeyPair,
  signSkill,
  toPublicJwk,
  type CapabilityManifest,
  type PrivateJwk,
  type SkillManifest,
  type SkillPackage,
} from '@oosr/core';
import { Hub, createHubServer } from '@oosr/hub';
import { RobotClient } from '@oosr/sim';

export const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);
export const ficusManifest = (): SkillManifest => JSON.parse(readFileSync(fixture('ficus-manifest.json'), 'utf8'));
export const acmeCapability = (): CapabilityManifest => JSON.parse(readFileSync(fixture('acme-capability.json'), 'utf8'));
export const KNOWLEDGE = readFileSync(fixture('ficus-knowledge.md'));

export const VIVERO = 'did:web:vivero-x.es';
export const VIVERO_KID = `${VIVERO}#key-1`;

export interface Env {
  hub: Hub;
  dir: string;
  url: string;
  ownerToken: string;
  publisherKey: PrivateJwk;
  owner<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  sign(manifest: SkillManifest, files?: Record<string, Uint8Array>): Promise<SkillPackage>;
  pairRobot(cap: CapabilityManifest, opts?: { write?: string[]; zones?: string[] }): Promise<RobotClient>;
  enrol(robot: RobotClient, tag: number, body: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Boots a fresh reference hub on a random port. Everything after boot goes through the HTTP API,
 * so pointing the suite at another implementation only requires replacing this function.
 */
export async function startEnv(opts: { now?: () => Date } = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'oosr-hub-'));
  const { hub, ownerToken } = await Hub.init(dir, { scopeId: 'hub-7f3a', policy: { trusted_publishers: [VIVERO] }, ...opts });
  const server: Server = createHubServer(hub);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { privateJwk: publisherKey } = await generateKeyPair(VIVERO_KID);

  const owner = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${ownerToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };

  // Pin the publisher key: local-first, no did:web fetch needed in tests.
  await owner('POST', '/v0/publishers/keys', { kid: VIVERO_KID, jwk: toPublicJwk(publisherKey) });

  const sign = async (manifest: SkillManifest, files: Record<string, Uint8Array> = { 'knowledge.md': KNOWLEDGE }) => {
    const signed = await signSkill(manifest, files, publisherKey, VIVERO_KID);
    return { manifest: signed, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
  };

  const pairRobot = async (cap: CapabilityManifest, policy: { write?: string[]; zones?: string[] } = {}) => {
    const { privateJwk } = await generateKeyPair();
    const client = new RobotClient({ hub: url, capability: cap, key: privateJwk });
    await client.pair(async (userCode) => {
      const r = await owner('POST', '/v0/pair/approve', { user_code: userCode, ...policy });
      if (r.status !== 200) throw new Error(`approve failed: ${JSON.stringify(r.body)}`);
    });
    return client;
  };

  const enrol = async (robot: RobotClient, tag: number, body: Record<string, unknown>) => {
    const e = await robot.proposeEnrolment({ tag_id: tag, tag_size_mm: 30, proposed_type: 'plant/ficus-lyrata', confidence: 0.82 });
    const r = await owner('POST', `/v0/enrolments/${e.id}/confirm`, body);
    if (r.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(r.body)}`);
    return r.body.object.id as string;
  };

  return {
    hub,
    dir,
    url,
    ownerToken,
    publisherKey,
    owner,
    sign,
    pairRobot,
    enrol,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const humanoidCapability = (): CapabilityManifest => ({
  oosr: '0.1',
  robot: 'urn:oosr:robot:otherco:hx-0042',
  model: 'otherco/humanoid-1',
  primitives: ['navigate_to', 'inspect', 'measure:soil_moisture', 'dispense:water', 'grasp', 'place', 'cut', 'notify_human'],
  limits: { payload_kg: 5, dispense_max_ml: 800 },
});

export const vacuumCapability = (): CapabilityManifest => ({
  oosr: '0.1',
  robot: 'urn:oosr:robot:roomba-like:v-77',
  model: 'roomba-like/v1',
  primitives: ['navigate_to', 'inspect'],
});
