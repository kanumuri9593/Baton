import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flutterConfigWith } from '../src/core/registry.ts';
import { buildFlutterArgv } from '../src/config/loader.ts';
import type { LaunchConfig } from '../src/config/loader.ts';

function flutterConfig(): LaunchConfig {
  return {
    name: 'Driver app (DEV)',
    kind: 'flutter',
    cwd: '/repo/mobile',
    toolArgs: ['--flavor', 'dev'],
    args: [],
    env: { EXISTING: 'kept' },
  };
}

test('workspace env reaches a Flutter app as dart defines, after the config\'s own tool args', () => {
  const config = flutterConfigWith(flutterConfig(), { API_URL: 'http://127.0.0.1:43121' });

  assert.deepEqual(config.toolArgs, ['--flavor', 'dev', '--dart-define=API_URL=http://127.0.0.1:43121']);
  assert.deepEqual(config.env, { EXISTING: 'kept', API_URL: 'http://127.0.0.1:43121' });
  assert.ok(buildFlutterArgv(config, 'emulator-5554').includes('--dart-define=API_URL=http://127.0.0.1:43121'));
});

test('workspace env wins over a value the launch config already declares', () => {
  const base = flutterConfig();
  base.env = { API_URL: 'http://localhost:3000' };
  const config = flutterConfigWith(base, { API_URL: 'http://127.0.0.1:43121' });

  assert.equal(config.env?.API_URL, 'http://127.0.0.1:43121');
  assert.deepEqual(config.toolArgs.filter((a) => a.startsWith('--dart-define')), ['--dart-define=API_URL=http://127.0.0.1:43121']);
});

test('with no workspace env the config is returned untouched, not cloned into a new shape', () => {
  const base = flutterConfig();
  assert.equal(flutterConfigWith(base, undefined), base);
  assert.equal(flutterConfigWith(base, {}), base);
});
