import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../src/core/registry.ts';
import type { Target } from '../src/config/detect.ts';

/**
 * A relaunch reuses the session id, so a stopped run must make way for the
 * new one instead of reporting "already running on this device".
 */
const registry = new SessionRegistry();
after(async () => { await registry.stopAll(); });

function sleeper(cwd: string): Target {
  return {
    name: 'relaunch', kind: 'process', source: 'auto', cwd,
    command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'],
  } as Target;
}

test('a stopped session can be run again on the same device', async () => {
  const target = sleeper(mkdtempSync(join(tmpdir(), 'baton-relaunch-')));
  const first = await registry.run(target);
  await assert.rejects(registry.run(target), /already running on this device/);
  await first.stop();

  const second = await registry.run(target);
  assert.equal(second.id, first.id);
  assert.notEqual(second, first);
  assert.equal(registry.get(first.id), second);
  assert.equal(registry.list().length, 1);
  await second.stop();
});
