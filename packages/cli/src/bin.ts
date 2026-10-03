#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  SCHEMA_DIR,
  buildDidDocument,
  compareSemver,
  findAssertionKey,
  generateKeyPair,
  issueDeviceCert,
  lintSkill,
  resolveDidWeb,
  signSkill,
  skillName,
  toPublicJwk,
  verifySkillPackage,
  type PrivateJwk,
  type PublicJwk,
  type SkillPackage,
} from '@oosr/core';
import { readSkillDir, toPackage } from './skilldir.js';

const USAGE = `oosr — OOSR publisher tools

Keys and identity
  oosr keygen   --did did:web:example.com [--fragment key-1] --out publisher.private.jwk.json
  oosr did      --key publisher.private.jwk.json --did did:web:example.com [--registry https://example.com/skills]

Skills
  oosr skill validate <dir>...
  oosr skill sign     <dir> --key publisher.private.jwk.json [--out signed-dir]
  oosr skill pack     <dir>                     (prints the package JSON the hub accepts at POST /v0/skills)
  oosr skill verify   <dir|package.json> [--jwk public.jwk.json]   (default: resolve did:web)

Manufacturers
  oosr device-cert issue --key manufacturer.private.jwk.json --robot urn:oosr:robot:acme:sn-1 --model acme/arm-2
                         --robot-jwk robot.public.jwk.json [--key-storage tpm|secure_element|software] [--days 3650]

Registry (static site, e.g. GitHub Pages)
  oosr registry build --skills skills --did did:web:example.com --base-url https://example.com
                      (--key file | --key-env OOSR_PUBLISHER_JWK) [--out site]
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    did: { type: 'string' },
    fragment: { type: 'string', default: 'key-1' },
    out: { type: 'string' },
    key: { type: 'string' },
    'key-env': { type: 'string' },
    registry: { type: 'string' },
    jwk: { type: 'string' },
    skills: { type: 'string', default: 'skills' },
    'base-url': { type: 'string' },
    robot: { type: 'string' },
    model: { type: 'string' },
    'robot-jwk': { type: 'string' },
    'key-storage': { type: 'string' },
    days: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const write = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};

function loadKey(): PrivateJwk {
  const raw = values['key-env'] ? process.env[values['key-env']] : values.key ? readFileSync(values.key, 'utf8') : undefined;
  if (!raw) throw new Error('a private key is required: --key <file> or --key-env <VAR>');
  const key = JSON.parse(raw) as PrivateJwk;
  if (!key.d || !key.kid) throw new Error('the key must be a private JWK with a kid (did:web:...#fragment)');
  return key;
}

async function cmdSkill(sub: string | undefined, args: string[]): Promise<void> {
  if (sub === 'validate') {
    let failed = 0;
    // A folder without a manifest is treated as a collection of skills (e.g. "skills/").
    const dirs = args.flatMap((d) =>
      existsSync(join(d, 'manifest.json'))
        ? [d]
        : readdirSync(d)
            .map((n) => join(d, n))
            .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'manifest.json'))),
    );
    for (const dir of dirs) {
      const { manifest, files } = readSkillDir(dir);
      const signed = Boolean(manifest.signature);
      const res = lintSkill(manifest, { signed });
      if (manifest.knowledge && !files[manifest.knowledge]) res.errors.push(`/knowledge ${manifest.knowledge} not found in ${dir}`);
      if (res.errors.length) {
        failed++;
        process.stdout.write(`✗ ${dir}\n${res.errors.map((e) => `    ${e}`).join('\n')}\n`);
      } else {
        process.stdout.write(`✓ ${dir}  ${manifest.id}@${manifest.version}${signed ? ' (signed)' : ''}\n`);
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (sub === 'sign') {
    const dir = args[0]!;
    const key = loadKey();
    const { manifest, files } = readSkillDir(dir);
    const signed = await signSkill(manifest, files, key, key.kid!);
    const out = values.out ?? dir;
    if (out !== dir) {
      cpSync(dir, out, { recursive: true });
    }
    write(join(out, 'manifest.json'), signed);
    process.stdout.write(`signed ${signed.id}@${signed.version} with ${key.kid} -> ${join(out, 'manifest.json')}\n`);
    return;
  }
  if (sub === 'pack') {
    const { manifest, files } = readSkillDir(args[0]!);
    process.stdout.write(`${JSON.stringify(toPackage(manifest, files))}\n`);
    return;
  }
  if (sub === 'verify') {
    const target = args[0]!;
    const pkg: SkillPackage = target.endsWith('.json')
      ? (JSON.parse(readFileSync(target, 'utf8')) as SkillPackage)
      : (() => {
          const { manifest, files } = readSkillDir(target);
          return toPackage(manifest, files);
        })();
    const resolver = values.jwk
      ? async () => JSON.parse(readFileSync(values.jwk!, 'utf8')) as PublicJwk
      : async (kid: string) => findAssertionKey(await resolveDidWeb(kid.split('#')[0]!), kid);
    await verifySkillPackage(pkg, resolver);
    process.stdout.write(`✓ ${pkg.manifest.id}@${pkg.manifest.version} verified (${pkg.manifest.signature!.kid})\n`);
    return;
  }
  throw new Error(`unknown skill command ${sub}`);
}

async function cmdRegistryBuild(): Promise<void> {
  const did = values.did;
  const baseUrl = values['base-url']?.replace(/\/$/, '');
  if (!did || !baseUrl) throw new Error('--did and --base-url are required');
  const key = loadKey();
  if (!key.kid!.startsWith(`${did}#`)) throw new Error(`key ${key.kid} does not belong to ${did}`);
  const out = values.out ?? 'site';
  const skillsRoot = values.skills!;
  const index: { publisher: string; skills: { id: string; title?: string; applies_to: string[]; versions: string[]; latest: string }[] } = {
    publisher: did,
    skills: [],
  };

  for (const name of readdirSync(skillsRoot).sort()) {
    const dir = join(skillsRoot, name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'manifest.json'))) continue;
    const { manifest, files } = readSkillDir(dir);
    if (manifest.publisher !== did) {
      process.stdout.write(`- skipping ${name}: publisher ${manifest.publisher} is not ${did}\n`);
      continue;
    }
    const signed = await signSkill(manifest, files, key, key.kid!);
    const pkg = toPackage(signed, files);
    await verifySkillPackage(pkg, async () => toPublicJwk(key));
    write(join(out, 'skills', skillName(signed.id), `${signed.version}.json`), pkg);
    write(join(out, 'skills', skillName(signed.id), signed.version, 'manifest.json'), signed);
    for (const [path, bytes] of Object.entries(files)) write(join(out, 'skills', skillName(signed.id), signed.version, path), Buffer.from(bytes));
    const entry = index.skills.find((s) => s.id === signed.id);
    if (entry) {
      entry.versions.push(signed.version);
      entry.versions.sort(compareSemver);
      entry.latest = entry.versions.at(-1)!;
    } else {
      index.skills.push({ id: signed.id, ...(signed.title ? { title: signed.title } : {}), applies_to: signed.applies_to, versions: [signed.version], latest: signed.version });
    }
    process.stdout.write(`+ ${signed.id}@${signed.version}\n`);
  }
  write(join(out, 'skills', 'index.json'), index);

  const fragment = key.kid!.split('#')[1]!;
  write(join(out, 'did.json'), buildDidDocument(did, [{ fragment, jwk: toPublicJwk(key) }], `${baseUrl}/skills`));
  cpSync(SCHEMA_DIR, join(out, 'schema', 'v0'), { recursive: true });
  process.stdout.write(`registry for ${did} written to ${out}/ (${index.skills.length} skills)\n`);
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === 'keygen') {
    if (!values.did || !values.out) throw new Error('--did and --out are required');
    const kid = `${values.did}#${values.fragment}`;
    const { privateJwk, publicJwk } = await generateKeyPair(kid);
    if (existsSync(values.out)) throw new Error(`${values.out} exists; refusing to overwrite a key`);
    write(values.out, privateJwk);
    process.stdout.write(`private key -> ${values.out} (keep it secret)\npublic JWK:\n${JSON.stringify(publicJwk, null, 2)}\n`);
    return;
  }
  if (cmd === 'did') {
    if (!values.did) throw new Error('--did is required');
    const key = loadKey();
    const fragment = key.kid!.split('#')[1]!;
    process.stdout.write(`${JSON.stringify(buildDidDocument(values.did, [{ fragment, jwk: toPublicJwk(key) }], values.registry), null, 2)}\n`);
    return;
  }
  if (cmd === 'skill') return cmdSkill(sub, rest);
  if (cmd === 'device-cert' && sub === 'issue') {
    if (!values.robot || !values.model || !values['robot-jwk']) throw new Error('--robot, --model and --robot-jwk are required');
    const key = loadKey();
    const storage = values['key-storage'];
    if (storage && !['tpm', 'secure_element', 'software'].includes(storage)) throw new Error('--key-storage must be tpm, secure_element or software');
    const iat = Math.floor(Date.now() / 1000);
    const cert = await issueDeviceCert(
      {
        iss: key.kid!.split('#')[0]!,
        sub: values.robot,
        model: values.model,
        cnf: { jwk: JSON.parse(readFileSync(values['robot-jwk'], 'utf8')) as PublicJwk },
        ...(storage ? { key_storage: storage as 'tpm' | 'secure_element' | 'software' } : {}),
        iat,
        ...(values.days ? { exp: iat + Number(values.days) * 86_400 } : {}),
      },
      key,
      key.kid!,
    );
    process.stdout.write(`${cert}\n`);
    return;
  }
  if (cmd === 'registry' && sub === 'build') return cmdRegistryBuild();
  throw new Error(`unknown command ${cmd} (${basename(process.argv[1] ?? 'oosr')} --help)`);
}

main().catch((e: Error) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exitCode = 1;
});
