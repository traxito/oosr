import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDidDocument, generateKeyPair, signSkill, toPublicJwk, type SkillManifest } from '@oosr/core';
import { Hub } from '@oosr/hub';
import { KNOWLEDGE, acmeCapability, ficusManifest } from './harness.js';

const DID = 'did:web:traxito.github.io:oosr';
const KID = `${DID}#key-1`;
const REF = 'skill:traxito.github.io/oosr/ficus-lyrata-care';

async function communityRegistry() {
  const { privateJwk } = await generateKeyPair(KID);
  const manifest: SkillManifest = { ...ficusManifest(), id: REF, publisher: DID, version: '1.0.0' };
  const sign = async (over: Partial<SkillManifest> = {}) => ({
    manifest: await signSkill({ ...manifest, ...over }, { 'knowledge.md': KNOWLEDGE }, privateJwk, KID),
    files: { 'knowledge.md': KNOWLEDGE.toString('base64') },
  });
  const pkg = await sign();
  const routes: Record<string, unknown> = {
    'https://traxito.github.io/oosr/did.json': buildDidDocument(DID, [{ fragment: 'key-1', jwk: toPublicJwk(privateJwk) }], 'https://traxito.github.io/oosr/skills'),
    'https://traxito.github.io/oosr/skills/index.json': {
      publisher: DID,
      skills: [{ id: REF, applies_to: ['plant/ficus-lyrata'], versions: ['1.0.0'], latest: '1.0.0' }],
    },
    'https://traxito.github.io/oosr/skills/ficus-lyrata-care/1.0.0.json': pkg,
  };
  const requested: string[] = [];
  const fetchImpl = (async (url: string) => {
    requested.push(url);
    const body = routes[url];
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  }) as typeof fetch;
  return { fetchImpl, requested, sign };
}

describe('community registry via did:web', () => {
  it('enrolment with a GS1-provided skill ref installs it from the publisher registry', async () => {
    const { fetchImpl, requested } = await communityRegistry();
    const { hub } = await Hub.init(mkdtempSync(join(tmpdir(), 'oosr-reg-')), { scopeId: 'hub-reg', policy: { trusted_publishers: [DID] }, fetchImpl });
    const { privateJwk } = await generateKeyPair();
    const { user_code } = hub.startPairing({ capability: acmeCapability(), public_jwk: toPublicJwk(privateJwk) });
    hub.approvePairing(user_code);
    const robot = { kind: 'robot' as const, robot: acmeCapability().robot };

    const e = hub.proposeEnrolment(robot, { tag_family: 'tag36h11', tag_id: 37, tag_size_mm: 30, proposed_type: 'plant/ficus-lyrata', skills: [{ ref: REF }] });
    const { object, skill_errors } = await hub.confirmEnrolment(e.id, { attributes: { pot_volume_l: 3 }, zone: 'salon' });
    expect(skill_errors).toEqual([]);
    expect(requested).toContain('https://traxito.github.io/oosr/did.json');
    expect(hub.listSkills().map((s) => `${s.id}@${s.version}`)).toEqual([`${REF}@1.0.0`]);
    expect(hub.tasksFor(object.id, robot).map((t) => [t.task, t.eligible])).toEqual([
      ['water', true],
      ['prune', false],
    ]);
  });

  it('does not fetch skills from untrusted publishers during enrolment', async () => {
    const { fetchImpl, requested } = await communityRegistry();
    const { hub } = await Hub.init(mkdtempSync(join(tmpdir(), 'oosr-reg-')), { scopeId: 'hub-reg', policy: { trusted_publishers: [] }, fetchImpl });
    const { privateJwk } = await generateKeyPair();
    const { user_code } = hub.startPairing({ capability: acmeCapability(), public_jwk: toPublicJwk(privateJwk) });
    hub.approvePairing(user_code);
    const e = hub.proposeEnrolment({ kind: 'robot', robot: acmeCapability().robot }, {
      tag_family: 'tag36h11', tag_id: 37, tag_size_mm: 30, proposed_type: 'plant/ficus-lyrata', skills: [{ ref: REF }],
    });
    const { skill_errors } = await hub.confirmEnrolment(e.id);
    expect(skill_errors).toEqual([`${REF}: publisher not trusted`]);
    expect(requested).toEqual([]);
  });

  it('accepts the same release re-signed (randomized ECDSA) but not different content under the same version', async () => {
    const { fetchImpl, sign } = await communityRegistry();
    const { hub } = await Hub.init(mkdtempSync(join(tmpdir(), 'oosr-reg-')), { scopeId: 'hub-reg', policy: { trusted_publishers: [DID] }, fetchImpl });
    await hub.installSkill(await sign());
    await expect(hub.installSkill(await sign())).resolves.toBeTruthy();
    await expect(hub.installSkill(await sign({ title: 'changed' }))).rejects.toThrow(/different content/);
  });
});
