import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChange, chooseAction, errorsSince, failedSince, type CheckHost } from '../src/daemon/check.ts';
import { stringParams } from '../src/adapters/flutter.ts';
import type { Capability, LogLine, NetworkRequestSnapshot, Session } from '../src/core/types.ts';

function fakeSession(kind: string, caps: Capability[], logs: LogLine[] = [], status: Session['status'] = 'running'): Session {
  return {
    id: `proj/${kind}`, kind, name: kind, capabilities: new Set(caps), status,
    recentLogs: () => logs,
  } as unknown as Session;
}

function fakeHost(overrides: Partial<CheckHost> = {}) {
  const calls: string[] = [];
  let clock = 1000;
  const host: CheckHost = {
    apply: async (_s, action) => { calls.push(action); return { code: 0 }; },
    waitReady: async () => { calls.push('wait'); },
    network: () => [],
    screenshot: async () => { calls.push('screenshot'); return { path: '/tmp/shot.png' }; },
    sleep: async (ms) => { calls.push(`sleep ${ms}`); clock += ms; },
    now: () => clock,
    ...overrides,
  };
  return { host, calls };
}

test('auto reloads Flutter, leaves web and React Native to HMR, restarts the rest', () => {
  assert.equal(chooseAction(fakeSession('flutter', ['hotReload', 'hotRestart'])), 'reload');
  assert.equal(chooseAction(fakeSession('web-dev', ['restartProcess', 'url'])), 'none');
  assert.equal(chooseAction(fakeSession('react-native', ['hotRestart', 'url'])), 'none');
  assert.equal(chooseAction(fakeSession('ios', ['restartProcess'])), 'restart');
  assert.equal(chooseAction(fakeSession('web-dev', ['url']), 'restart'), 'restart');
});

test('only errors logged after the check began are reported', () => {
  const lines: LogLine[] = [
    { at: 10, text: 'Error: old noise', error: true },
    { at: 20, text: 'compiled fine', error: false },
    { at: 30, text: '[vite] Internal server error: Unexpected token', error: false },
    { at: 31, text: 'TypeError: x is undefined', error: true },
  ];
  assert.deepEqual(errorsSince(lines, 20), ['[vite] Internal server error: Unexpected token', 'TypeError: x is undefined']);
});

test('failed requests are errors and 4xx/5xx, not successes', () => {
  const reqs = [
    { method: 'GET', uri: 'https://a/ok', statusCode: 200 },
    { method: 'POST', uri: 'https://a/bad', statusCode: 500 },
    { method: 'GET', uri: 'https://a/down', error: 'SocketException' },
  ] as NetworkRequestSnapshot[];
  assert.deepEqual(failedSince(reqs), ['POST 500 https://a/bad', 'GET ERR https://a/down  SocketException']);
});

test('a clean Flutter check reloads, settles, screenshots and is ok', async () => {
  const { host, calls } = fakeHost();
  const r = await checkChange(fakeSession('flutter', ['hotReload']), { session: 'x' }, host);
  assert.deepEqual(calls, ['reload', 'sleep 1500', 'screenshot']);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'reload');
  assert.equal(r.screenshotPath, '/tmp/shot.png');
});

test('a failed reload is not ok and carries the compile error', async () => {
  const { host } = fakeHost({ apply: async () => ({ code: 1, message: 'compile failed', errors: ['lib/main.dart:3: Expected ;'] }) });
  const r = await checkChange(fakeSession('flutter', ['hotReload']), { session: 'x', screenshot: false }, host);
  assert.equal(r.ok, false);
  assert.deepEqual(r.operation?.errors, ['lib/main.dart:3: Expected ;']);
  assert.equal(r.screenshotPath, undefined);
});

test('a restart waits for the session to be ready again', async () => {
  const { host, calls } = fakeHost();
  await checkChange(fakeSession('process', ['restartProcess']), { session: 'x', settleMs: 0 }, host);
  assert.deepEqual(calls, ['restart', 'wait', 'screenshot']);
});

test('a screenshot that cannot be taken is reported without failing the check', async () => {
  const { host } = fakeHost({ screenshot: async () => { throw new Error('no browser'); } });
  const r = await checkChange(fakeSession('web-dev', ['url']), { session: 'x', settleMs: 0 }, host);
  assert.equal(r.ok, true);
  assert.equal(r.screenshotError, 'no browser');
});

test('new failed requests make the check not ok', async () => {
  const { host } = fakeHost({
    network: () => [{ method: 'GET', uri: 'https://api/x', statusCode: 404 }] as NetworkRequestSnapshot[],
  });
  const r = await checkChange(fakeSession('flutter', ['hotReload']), { session: 'x', settleMs: 0, screenshot: false }, host);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failedRequests, ['GET 404 https://api/x']);
});

test('what the page reported in the browser makes a web check not ok', async () => {
  const { host } = fakeHost({
    screenshot: async () => ({
      path: '/tmp/web.png',
      consoleErrors: ["SyntaxError: Unexpected token '<<'"],
      failedRequests: ['GET 404 http://localhost:5173/logo.svg'],
    }),
  });
  const r = await checkChange(fakeSession('web-dev', ['url']), { session: 'x', settleMs: 0 }, host);
  assert.equal(r.ok, false);
  assert.deepEqual(r.newErrors, ["[browser] SyntaxError: Unexpected token '<<'"]);
  assert.deepEqual(r.failedRequests, ['[browser] GET 404 http://localhost:5173/logo.svg']);
});

test('Flutter service extension params are sent as the strings Flutter reads', () => {
  assert.deepEqual(stringParams({ enabled: true, timeDilation: 5, skip: undefined, label: 'x' }), {
    enabled: 'true', timeDilation: '5', label: 'x',
  });
});
