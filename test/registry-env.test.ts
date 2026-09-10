import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../src/core/registry.ts';
import type { Session } from '../src/core/types.ts';
import type { Target, TargetKind } from '../src/config/detect.ts';
import type { LaunchConfig } from '../src/config/loader.ts';

/**
 * Whether a launch.json `env` block reaches the child process, for every
 * adapter that spawns a plain child (`process`, `web-dev`, `react-native`).
 *
 * Each prints its env var and exits immediately, so the assertion is just
 * "did the value show up in the session's log stream".
 */
function envTarget(kind: TargetKind, cwd: string): Target {
  const script = "process.stdout.write('VALUE=' + (process.env.BATON_ENV_TEST || 'MISSING'))";
  const config: LaunchConfig = {
    name: `${kind}-env-test`,
    kind: 'process',
    cwd,
    toolArgs: [],
    args: [],
    env: { BATON_ENV_TEST: 'from-launch-json' },
  };
  return {
    name: `${kind}-env-test`,
    kind,
    source: 'launch.json',
    cwd,
    command: process.execPath,
    args: ['-e', script],
    config,
  };
}

const registry = new SessionRegistry();
after(async () => { await registry.stopAll(); });

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'baton-env-'));
}

async function waitForExit(session: Session): Promise<void> {
  await new Promise<void>((resolve) => session.on('exit', () => resolve()));
}

test('registry forwards launch.json env into a process-kind session child', async () => {
  const session = await registry.run(envTarget('process', tmpProject()));
  await waitForExit(session);
  const text = session.recentLogs().map((l) => l.text).join('');
  assert.match(text, /VALUE=from-launch-json/);
});

test('registry forwards launch.json env into a web-dev-kind session child', async () => {
  const session = await registry.run(envTarget('web-dev', tmpProject()));
  await waitForExit(session);
  const text = session.recentLogs().map((l) => l.text).join('');
  assert.match(text, /VALUE=from-launch-json/);
});

test('registry forwards launch.json env into a react-native-kind session child', async () => {
  const session = await registry.run(envTarget('react-native', tmpProject()));
  await waitForExit(session);
  const text = session.recentLogs().map((l) => l.text).join('');
  assert.match(text, /VALUE=from-launch-json/);
});

test('a workspace\'s env is merged over the launch.json env and reaches the child', async () => {
  const target = envTarget('process', tmpProject());
  target.name = 'workspace-env';
  const session = await registry.run(target, { env: { BATON_ENV_TEST: 'from-workspace' } });
  await waitForExit(session);
  assert.match(session.recentLogs().map((l) => l.text).join(''), /VALUE=from-workspace/);
});

test('launch.json keys the workspace does not mention survive the merge', async () => {
  const target = envTarget('process', tmpProject());
  target.name = 'workspace-env-merge';
  target.args = ['-e', "process.stdout.write('VALUE=' + process.env.BATON_ENV_TEST + ' EXTRA=' + process.env.API_URL)"];
  const session = await registry.run(target, { env: { API_URL: 'http://127.0.0.1:43121' } });
  await waitForExit(session);
  assert.match(session.recentLogs().map((l) => l.text).join(''), /VALUE=from-launch-json EXTRA=http:\/\/127\.0\.0\.1:43121/);
});

test('Node targets still launch when a desktop environment omits Node from PATH', async () => {
  const target = envTarget('process', tmpProject());
  target.name = 'desktop-node';
  target.command = 'node';
  target.config!.env = { BATON_ENV_TEST: 'from-launch-json', PATH: '' };
  const session = await registry.run(target);
  await waitForExit(session);
  assert.match(session.recentLogs().map(l=>l.text).join(''),/VALUE=from-launch-json/);
});
