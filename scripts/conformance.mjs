#!/usr/bin/env node
// Runs the OOSR hub conformance suite against any hub over HTTP.
// Usage: npm run conformance -- --url http://127.0.0.1:7400 --token <owner token>
// The hub must accept the test publisher (did:web:vivero-x.es) and manufacturer (did:web:acme.example)
// keys through POST /v0/trust/keys; the suite restores the owner's policy when it finishes.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, token: { type: 'string' } } });
if (!values.url || !values.token) {
  process.stderr.write('usage: npm run conformance -- --url <hub url> --token <owner token>\n');
  process.exit(2);
}

const res = spawnSync('npx', ['vitest', 'run', 'packages/conformance', '--no-file-parallelism'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, OOSR_HUB_URL: values.url, OOSR_OWNER_TOKEN: values.token },
});
process.exit(res.status ?? 1);
