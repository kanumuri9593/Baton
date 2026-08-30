import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sessionId } from '../src/core/session-base.ts';
import { SessionRegistry } from '../src/core/registry.ts';
import type { Target } from '../src/config/detect.ts';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a session id names the project it belongs to', () => {
  assert.equal(sessionId('/Users/me/code/demo-web', 'npm dev'), 'demo-web/npm-dev');
  assert.equal(
    sessionId('C:\\Users\\me\\code\\storefront', 'npm dev'),
    'storefront/npm-dev',
    'Windows paths split on backslashes too',
  );
});

test('two projects can both have an "npm dev" without colliding', () => {
  const web = sessionId('/tmp/demo-web', 'npm dev');
  const api = sessionId('/tmp/demo-api', 'npm dev');
  assert.notEqual(web, api);
});

test('the device is part of the id, so one config can run on several simulators', () => {
  const iphone = sessionId('/tmp/app', 'iOS Simulator (DEV)', '48F0A0D1');
  const ipad = sessionId('/tmp/app', 'iOS Simulator (DEV)', 'F9E4AE5F');
  assert.notEqual(iphone, ipad);
  assert.ok(iphone.startsWith('app/ios-simulator-dev'));
});

// --- against a live registry ---------------------------------------------

const registry = new SessionRegistry();

/** A real directory, because a child cannot be spawned in one that is absent. */
function tmpProject(name: string): string {
  const dir = join(tmpdir(), 'clilaunch-ids', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
after(async () => { await registry.stopAll(); });

/**
 * A target that starts, prints nothing and exits at once.
 *
 * Naming, registration and lookup all happen before the process matters, so the
 * cheapest possible command keeps these tests about ids and nothing else.
 */
function namedTarget(cwd: string): Target {
  const windows = process.platform === 'win32';
  return {
    name: 'npm dev',
    kind: 'process',
    source: 'package.json',
    cwd,
    command: windows ? 'cmd' : 'true',
    args: windows ? ['/c', 'exit', '0'] : [],
  };
}

test('the same target name in two projects both run, and stay separable', async () => {
  const web = await registry.run(namedTarget(tmpProject('demo-web')));
  const api = await registry.run(namedTarget(tmpProject('demo-api')));

  assert.equal(web.id, 'demo-web/npm-dev');
  assert.equal(api.id, 'demo-api/npm-dev');
  assert.equal(registry.list().length, 2, 'the second must not be rejected as a duplicate');

  // Each snapshot says which project it came from, which is what lets the HUD
  // group three projects in one list.
  assert.equal(web.snapshot().root, tmpProject('demo-web'));
  assert.equal(api.snapshot().root, tmpProject('demo-api'));
});

test('an ambiguous short name resolves to nothing, and lists the options', () => {
  assert.equal(registry.get('npm-dev'), undefined, 'guessing between projects would be wrong');
  const options = registry.candidates('npm-dev').map((s) => s.id).sort();
  assert.deepEqual(options, ['demo-api/npm-dev', 'demo-web/npm-dev']);
});

test('a fully qualified name still resolves directly', () => {
  assert.equal(registry.get('demo-web/npm-dev')?.id, 'demo-web/npm-dev');
  assert.equal(registry.get('demo-api/')?.id, 'demo-api/npm-dev', 'a unique prefix is enough');
});
