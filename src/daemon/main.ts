#!/usr/bin/env node
import { LaunchDaemon } from './server.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
);

const daemon = new LaunchDaemon(pkg.version);
const handshake = await daemon.listen(Number(process.env.CLILAUNCH_PORT ?? 0));

console.log(`clilaunch daemon ${pkg.version} listening on http://127.0.0.1:${handshake.port}`);

const shutdown = async () => {
  await daemon.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
