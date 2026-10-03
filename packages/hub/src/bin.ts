#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { auditRobot } from './audit.js';
import { Hub } from './hub.js';
import { createHubServer } from './http.js';

const USAGE = `oosr-hub — OOSR reference hub

Usage:
  oosr-hub init  [--data ./data] [--scope hub-7f3a] [--trust did:web:example.com ...] [--timezone Europe/Madrid]
  oosr-hub start [--data ./data] [--port 7400] [--host 127.0.0.1]
  oosr-hub audit [--data ./data] --robot urn:oosr:robot:acme:sn-88412 [--json]   (robot-role conformance)
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string', default: './data' },
    scope: { type: 'string' },
    trust: { type: 'string', multiple: true },
    timezone: { type: 'string' },
    port: { type: 'string', default: '7400' },
    host: { type: 'string', default: '127.0.0.1' },
    robot: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

async function main(): Promise<void> {
  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === 'init') {
    const { hub, ownerToken } = await Hub.init(values.data!, {
      ...(values.scope ? { scopeId: values.scope } : {}),
      policy: {
        trusted_publishers: values.trust ?? [],
        ...(values.timezone ? { timezone: values.timezone } : {}),
      },
    });
    process.stdout.write(
      `Hub ${hub.identity.hub} initialized in ${values.data}\n\n` +
        `Owner token (shown once, paste it in the app):\n\n  ${ownerToken}\n\n` +
        `Start it with: oosr-hub start --data ${values.data}\n`,
    );
    return;
  }
  if (cmd === 'start') {
    const hub = Hub.open(values.data!);
    const server = createHubServer(hub);
    const port = Number(values.port);
    server.listen(port, values.host, () => {
      process.stdout.write(`${hub.identity.hub} listening on http://${values.host}:${port}  (app: http://${values.host}:${port}/app/)\n`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (cmd === 'audit') {
    if (!values.robot) throw new Error('--robot is required');
    const report = await auditRobot(Hub.open(values.data!), values.robot);
    if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      const icon = { pass: '✓', warn: '!', fail: '✗' } as const;
      process.stdout.write(`${report.robot}: ${report.events} events, ${report.rejections} refused writes\n`);
      for (const c of report.checks) process.stdout.write(`  ${icon[c.status]} ${c.id.padEnd(24)} ${c.detail}\n`);
      process.stdout.write(report.ok ? 'CONFORMANT\n' : 'NOT CONFORMANT\n');
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  process.stderr.write(`unknown command ${cmd}\n\n${USAGE}`);
  process.exitCode = 2;
}

main().catch((e: Error) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exitCode = 1;
});
