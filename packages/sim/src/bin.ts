#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { generateKeyPair, type CapabilityManifest, type PrivateJwk } from '@oosr/core';
import { RobotClient } from './client.js';
import { SimRobot, type SimWorld } from './robot.js';

const USAGE = `oosr-sim — simulated OOSR robot

Usage:
  oosr-sim keygen  --robot urn:oosr:robot:acme:sn-88412 [--out .oosr/robot-key.json]
                   (writes the robot key and prints its public JWK for the manufacturer's certificate)
  oosr-sim pair    --hub http://127.0.0.1:7400 --robot urn:oosr:robot:acme:sn-88412 --model acme/helper-arm-2
                   --primitives navigate_to,inspect,measure:soil_moisture,dispense:water,notify_human
                   [--limit dispense_max_ml=1000 ...] [--profile .oosr/robot.json]
                   [--key .oosr/robot-key.json] [--device-cert cert.jwt]
  oosr-sim see     --tag 37 [--size 30] --type plant/ficus-lyrata [--confidence 0.82] [--zone living-room]
                   [--skill skill:traxito.github.io/oosr/ficus-lyrata-care] [--profile ...]
  oosr-sim world   --tag 37 [--moisture 0.12] [--spots true|false] [--world .oosr/world.json]
  oosr-sim run     [--every 30] [--profile ...] [--world .oosr/world.json]
`;

interface Profile {
  hub: string;
  capability: CapabilityManifest;
  key: PrivateJwk;
  token?: string;
  scope_id?: string;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: 'string', default: 'http://127.0.0.1:7400' },
    robot: { type: 'string' },
    model: { type: 'string' },
    primitives: { type: 'string' },
    limit: { type: 'string', multiple: true },
    profile: { type: 'string', default: '.oosr/robot.json' },
    world: { type: 'string', default: '.oosr/world.json' },
    tag: { type: 'string' },
    size: { type: 'string', default: '30' },
    type: { type: 'string' },
    confidence: { type: 'string' },
    zone: { type: 'string' },
    skill: { type: 'string', multiple: true },
    moisture: { type: 'string' },
    spots: { type: 'string' },
    every: { type: 'string' },
    key: { type: 'string' },
    out: { type: 'string', default: '.oosr/robot-key.json' },
    'device-cert': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const readJson = <T>(path: string, fallback?: T): T => {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${path} not found`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

function client(): { profile: Profile; client: RobotClient } {
  const profile = readJson<Profile>(values.profile!);
  if (!profile.token) throw new Error('robot is not paired; run "oosr-sim pair" first');
  return { profile, client: new RobotClient({ hub: profile.hub, capability: profile.capability, key: profile.key, token: profile.token }) };
}

async function main(): Promise<void> {
  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'keygen') {
    if (!values.robot) throw new Error('--robot is required');
    if (existsSync(values.out!)) throw new Error(`${values.out} exists; refusing to overwrite a key`);
    const { privateJwk, publicJwk } = await generateKeyPair(`${values.robot}#att`);
    writeJson(values.out!, privateJwk);
    process.stdout.write(`private key -> ${values.out}\npublic JWK (give it to the manufacturer):\n${JSON.stringify(publicJwk)}\n`);
    return;
  }

  if (cmd === 'pair') {
    if (!values.robot || !values.model || !values.primitives) throw new Error('--robot, --model and --primitives are required');
    const limits = Object.fromEntries((values.limit ?? []).map((l) => {
      const [k, v] = l.split('=');
      return [k!, Number(v)];
    }));
    const capability: CapabilityManifest = {
      oosr: '0.1',
      robot: values.robot,
      model: values.model,
      primitives: values.primitives.split(',').map((s) => s.trim()).filter(Boolean),
      ...(Object.keys(limits).length ? { limits } : {}),
    };
    const privateJwk = values.key ? readJson<PrivateJwk>(values.key) : (await generateKeyPair(`${values.robot}#att`)).privateJwk;
    const deviceCert = values['device-cert'] ? readFileSync(values['device-cert'], 'utf8').trim() : undefined;
    const c = new RobotClient({ hub: values.hub!, capability, key: privateJwk });
    const token = await c.pair(
      (code, uri) => {
        process.stdout.write(`Approve this robot in the app with code  ${code}\n  ${uri}\n`);
      },
      deviceCert ? { deviceCert } : {},
    );
    const info = await c.info();
    writeJson(values.profile!, { hub: values.hub, capability, key: privateJwk, token, scope_id: info.scope_id } satisfies Profile);
    process.stdout.write(`Paired with ${info.hub}. Profile saved to ${values.profile} (contains the robot private key).\n`);
    return;
  }

  if (cmd === 'see') {
    const { profile, client: c } = client();
    const tag = Number(values.tag);
    try {
      const { object } = await c.resolve(profile.scope_id!, tag);
      process.stdout.write(`tag #${tag} -> ${object}\n`);
      return;
    } catch {
      // Unbound: propose an enrolment for the human to confirm.
    }
    if (!values.type) throw new Error(`tag #${tag} is not bound; pass --type to propose an enrolment`);
    const e = await c.proposeEnrolment({
      tag_id: tag,
      tag_size_mm: Number(values.size),
      proposed_type: values.type,
      ...(values.confidence ? { confidence: Number(values.confidence) } : {}),
      ...(values.zone ? { zone: values.zone } : {}),
      ...(values.skill?.length ? { skills: values.skill.map((ref) => ({ ref })) } : {}),
    });
    process.stdout.write(`tag #${tag} is new: enrolment ${e.id} is waiting for confirmation in the app\n`);
    return;
  }

  if (cmd === 'world') {
    const world = readJson<SimWorld>(values.world!, { tags: {} });
    const cell = (world.tags[values.tag!] ??= {});
    if (values.moisture !== undefined) cell.soil_moisture = Number(values.moisture);
    if (values.spots !== undefined) cell.leaf_spots = values.spots === 'true';
    writeJson(values.world!, world);
    process.stdout.write(`${JSON.stringify(world.tags)}\n`);
    return;
  }

  if (cmd === 'run') {
    const { client: c } = client();
    await c.publishCapability();
    const loop = async () => {
      const world = readJson<SimWorld>(values.world!, { tags: {} });
      const robot = new SimRobot(c, world, (l) => process.stdout.write(`${l}\n`));
      process.stdout.write(`[${new Date().toISOString()}] cycle\n`);
      for (const r of await robot.cycle()) process.stdout.write(`  -> ${r.task}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}\n`);
      writeJson(values.world!, world);
    };
    await loop();
    if (values.every) setInterval(() => loop().catch((e) => process.stderr.write(`${e.message}\n`)), Number(values.every) * 1000);
    return;
  }

  process.stderr.write(`unknown command ${cmd}\n\n${USAGE}`);
  process.exitCode = 2;
}

main().catch((e: Error) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exitCode = 1;
});
