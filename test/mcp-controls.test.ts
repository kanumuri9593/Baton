import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controls, type Exec } from '../src/mcp/controls.ts';
import { dashboardHtml } from '../src/mcp/dashboard.ts';
import type { SessionSnapshot } from '../src/core/types.ts';

/** Pause, resume and bring to front for the Baton card, against a fake `ps`. */
const UDID = '2F77F133-1C2D-4E5F-8A9B-0C1D2E3F4A5B';
const sim: SessionSnapshot = {
  id: 'corerun', name: 'CoreRun', kind: 'ios', status: 'running', target: UDID, pid: 100,
  capabilities: ['hotRestart', 'stop', 'screenshot'], startedAt: 0,
};
const web: SessionSnapshot = {
  id: 'site', name: 'Site', kind: 'web-dev', status: 'running', target: 'web', pid: 200, url: 'http://127.0.0.1:5173',
  capabilities: ['restartProcess', 'stop'], startedAt: 0,
};
const android: SessionSnapshot = { ...sim, id: 'droid', kind: 'android', target: 'emulator-5554' };

function fake(stat: Record<number, string>) {
  const calls: string[][] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args]);
    if (command !== 'ps') return '';
    return [
      `  100     1 ${stat[100] ?? 'S'}  xcrun simctl launch --console ${UDID} com.example.corerun`,
      `  300     1 ${stat[300] ?? 'S'}  /Users/v/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/AB/Runner.app/Runner`,
      `  200     1 ${stat[200] ?? 'S'}  node vite`,
      `  201   200 ${stat[201] ?? 'S'}  esbuild --service`,
      `  999     1 S  unrelated`,
    ].join('\n');
  };
  return { exec, calls };
}

test('pausing a simulator run stops the app on that simulator, not the launcher', () => {
  const { exec, calls } = fake({});
  const c = new Controls(exec, 'darwin');
  assert.equal(c.canPause(sim), true);
  c.pause(sim);
  assert.deepEqual(calls.at(-1), ['kill', '-STOP', '300']);
  c.resume(sim);
  assert.deepEqual(calls.at(-1), ['kill', '-CONT', '300']);
});

test('a web run pauses its whole process tree', () => {
  const { exec, calls } = fake({});
  new Controls(exec, 'darwin').pause(web);
  assert.deepEqual(calls.at(-1), ['kill', '-STOP', '200', '201']);
});

test('paused is read back from the OS, so every card agrees', () => {
  const c = new Controls(fake({ 300: 'T', 200: 'T', 201: 'S' }).exec, 'darwin');
  assert.deepEqual([...c.pausedIds([sim, web])], ['corerun']);
});

test('bring to front opens Simulator or the run URL; Android and other OSes get no buttons', () => {
  const { exec, calls } = fake({});
  const c = new Controls(exec, 'darwin');
  c.front(sim);
  assert.deepEqual(calls.at(-1), ['open', '-a', 'Simulator']);
  c.front(web);
  assert.deepEqual(calls.at(-1), ['open', 'http://127.0.0.1:5173']);
  assert.equal(c.canPause(android), false);
  const linux = new Controls(exec, 'linux');
  assert.equal(linux.canPause(sim), false);
  assert.equal(linux.canFront(web), false);
});

test('the card script parses and offers every control', () => {
  const html = dashboardHtml('9.9.9');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
  assert.doesNotThrow(() => new Function(script));
  for (const action of ['catalog', 'run', 'boot', 'logs', 'pause', 'resume', 'front', 'restart_all', 'stop_all']) {
    assert.match(html, new RegExp(`'${action}'|"${action}"|${action}:`), action);
  }
});
