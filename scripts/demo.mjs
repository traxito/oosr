#!/usr/bin/env node
// End-to-end demo of RFC-0001 §8 against a real hub, then leaves the hub running for the app.
// Usage: npm run build && npm run demo   (then open the printed URL)
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, issueDeviceCert, signSkill, toPublicJwk } from '@oosr/core';
import { Hub, createHubServer } from '@oosr/hub';
import { RobotClient, SimRobot } from '@oosr/sim';
import { readSkillDir, toPackage } from '../packages/cli/dist/skilldir.js';

const PORT = Number(process.env.PORT ?? 7400);
const DIR = join('.oosr', 'demo');
// Local stand-in for a real publisher, so the demo works offline. Real hubs fetch community
// skills signed by did:web:traxito.github.io:oosr instead.
const PUBLISHER = 'did:web:demo.local';
// Stand-in manufacturer that certifies the arm's attestation key.
const MANUFACTURER = 'did:web:acme.example';
const say = (s) => process.stdout.write(`${s}\n`);

rmSync(DIR, { recursive: true, force: true });
const { hub, ownerToken } = await Hub.init(DIR, {
  scopeId: 'hub-demo',
  policy: { trusted_publishers: [PUBLISHER], trusted_manufacturers: { acme: MANUFACTURER }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
});
const server = createHubServer(hub);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const url = `http://127.0.0.1:${PORT}`;
const owner = async (method, path, body) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};

say(`\n▸ Hub ${hub.identity.hub} on ${url}`);

// Publisher: sign the community skills under the demo namespace and install them.
const { privateJwk } = await generateKeyPair(`${PUBLISHER}#key-1`);
await owner('POST', '/v0/trust/keys', { kid: `${PUBLISHER}#key-1`, jwk: toPublicJwk(privateJwk) });
const { privateJwk: makerKey } = await generateKeyPair(`${MANUFACTURER}#key-1`);
await owner('POST', '/v0/trust/keys', { kid: `${MANUFACTURER}#key-1`, jwk: toPublicJwk(makerKey) });
for (const name of ['ficus-lyrata-care', 'monstera-deliciosa-care', 'ocimum-basilicum-care', 'spathiphyllum-care', 'succulent-care', 'plant-generic-care']) {
  const { manifest, files } = readSkillDir(join('skills', name));
  const local = { ...manifest, id: `skill:demo.local/${name}`, publisher: PUBLISHER };
  const signed = await signSkill(local, files, privateJwk, `${PUBLISHER}#key-1`);
  await owner('POST', '/v0/skills', toPackage(signed, files));
}
say('▸ Installed 6 signed skills');

// Robots from two vendors, paired with the device grant (auto-approved here).
const pair = async (capability, certified = false) => {
  const { privateJwk: key } = await generateKeyPair();
  const deviceCert = certified
    ? await issueDeviceCert(
        { iss: MANUFACTURER, sub: capability.robot, model: capability.model, cnf: { jwk: toPublicJwk(key) }, key_storage: 'tpm' },
        makerKey,
        `${MANUFACTURER}#key-1`,
      )
    : undefined;
  const c = new RobotClient({ hub: url, capability, key });
  await c.pair((code) => owner('POST', '/v0/pair/approve', { user_code: code }), deviceCert ? { deviceCert } : {});
  return c;
};
const arm = await pair({
  oosr: '0.1',
  robot: 'urn:oosr:robot:acme:sn-88412',
  model: 'acme/helper-arm-2',
  primitives: ['navigate_to', 'inspect', 'measure:soil_moisture', 'dispense:water', 'grasp', 'place', 'notify_human'],
  limits: { payload_kg: 1.5, reach_m: 0.8, dispense_max_ml: 1000 },
}, true);
const humanoid = await pair({
  oosr: '0.1',
  robot: 'urn:oosr:robot:otherco:hx-0042',
  model: 'otherco/humanoid-1',
  primitives: ['navigate_to', 'inspect', 'measure:soil_moisture', 'dispense:water', 'grasp', 'place', 'cut', 'notify_human'],
  limits: { payload_kg: 5, dispense_max_ml: 800 },
});
say('▸ Paired acme/helper-arm-2 (with an acme device certificate) and otherco/humanoid-1 (without one)');

// Enrolment: the robot proposes, the human confirms.
const enrol = async (tag, type, confirm) => {
  const e = await arm.proposeEnrolment({ tag_id: tag, tag_size_mm: 30, proposed_type: type, confidence: 0.82, zone: confirm.zone });
  const { object } = await owner('POST', `/v0/enrolments/${e.id}/confirm`, confirm);
  return object.id;
};
const name = (n) => `skill:demo.local/${n}`;
await enrol(37, 'plant/ficus-lyrata', { name: 'Living room ficus', zone: 'living-room', attributes: { pot_volume_l: 3 }, skills: [{ ref: name('ficus-lyrata-care') }] });
await enrol(12, 'plant/monstera-deliciosa', { name: 'Bedroom monstera', zone: 'bedroom', attributes: { pot_volume_l: 8 }, skills: [] });
await enrol(5, 'plant/ocimum-basilicum', { name: 'Kitchen basil', zone: 'kitchen', attributes: { pot_volume_l: 1 }, skills: [] });
say('▸ Enrolled ficus (#37), monstera (#12) and basil (#5) after human confirmation');

// The world as the sensors see it.
const world = { tags: { 37: { soil_moisture: 0.12, leaf_spots: true }, 12: { soil_moisture: 0.35 }, 5: { soil_moisture: 0.22 } } };

say('\n▸ acme arm: scheduler cycle');
for (const r of await new SimRobot(arm, world, say).cycle()) say(`  → ${r.task}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);

say('\n▸ otherco humanoid, a bit later: reads the shared state');
for (const r of await new SimRobot(humanoid, world, say).cycle()) say(`  → ${r.task}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);

for (const robot of [arm, humanoid]) {
  const report = await owner('GET', `/v0/robots/${encodeURIComponent(robot.robot)}/audit`);
  const warnings = report.checks.filter((c) => c.status !== 'pass').map((c) => c.id);
  say(`▸ Robot-role audit of ${robot.capability.model}: ${report.ok ? 'conformant' : 'NOT conformant'}${warnings.length ? ` (warnings: ${warnings.join(', ')})` : ''}`);
}

// Leave something in the inbox for the app: a new tag and a robot waiting to pair.
await humanoid.proposeEnrolment({ tag_id: 21, tag_size_mm: 30, proposed_type: 'plant/spathiphyllum', confidence: 0.67, zone: 'hallway' });
const { privateJwk: vkey } = await generateKeyPair();
await fetch(`${url}/v0/pair/device`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    capability: { oosr: '0.1', robot: 'urn:oosr:robot:cleanco:v-77', model: 'cleanco/vacuum-3', primitives: ['navigate_to', 'inspect'] },
    public_jwk: toPublicJwk(vkey),
  }),
});

say(`
▸ Open the app: ${url}/app/
  Owner token: ${ownerToken}

  Waiting for you there: a leaf-spot alert on the ficus, a new tag (#21) to confirm and a vacuum to pair.
  Ctrl+C to stop.`);
