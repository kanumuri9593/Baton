#!/usr/bin/env node
import { LaunchDaemon } from './server.ts';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function getVersion(): string {
  if (process.env.BATON_VERSION) return process.env.BATON_VERSION;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../package.json', '../../package.json']) {
    const p = join(here, rel);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version;
  }
  return 'unknown';
}

const version = getVersion();
const daemon = new LaunchDaemon(version);
const handshake = await daemon.listen(Number(process.env.BATON_PORT ?? 0));

console.log(`baton daemon ${version} listening on http://127.0.0.1:${handshake.port}`);

const shutdown = async () => {
  await daemon.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
