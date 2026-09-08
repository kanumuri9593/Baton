import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../src/core/registry.ts';
import { FlutterSession } from '../src/adapters/flutter.ts';
import { buildFlutterArgv } from '../src/config/loader.ts';

test('explicit simulator overrides launch.json device in both snapshot and Flutter argv', async (t) => {
  const registry = new SessionRegistry();
  t.mock.method(registry, 'devices', () => ({
    waitForDevice: async (_name: string, id: string) => ({ id, name: 'Picked simulator' }),
  }));
  t.mock.method(FlutterSession.prototype, 'start', () => {});
  const session = await registry.run({
    name: 'Web default', kind: 'flutter', source: 'launch.json', cwd: process.cwd(),
    config: { name: 'Web default', kind: 'flutter', cwd: process.cwd(), deviceId: 'chrome', toolArgs: [], args: [] },
  }, { deviceId: 'picked-simulator' }) as FlutterSession;
  assert.equal(session.snapshot().target, 'picked-simulator');
  const argv = buildFlutterArgv(session.config, session.deviceId);
  assert.equal(argv[argv.indexOf('-d') + 1], 'picked-simulator');
});
