import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-proof-'));

const {
  expandProofMatrix, runCellChecks, countFailedRequests, cellId, textScaleToIosContentSize,
  writeProofBundle, runProof, parseAppearanceList, resolveDeviceQuery,
  summarizeNetwork, formatCellLabel, requestPath,
} = await import('../src/daemon/proof.ts');
import type { ProofCellSpec, ProofHost, ProofRunSummary } from '../src/daemon/proof.ts';
import type { Device } from '../src/daemon/devices.ts';
import type { Bootable } from '../src/daemon/simulators.ts';
import type { LogLine, NetworkRequestSnapshot, Session } from '../src/core/types.ts';
import type { Target } from '../src/config/detect.ts';

const IPHONE: Device = {
  id: 'sim-iphone-se',
  name: 'iPhone SE',
  platform: 'ios',
  platformType: 'ios',
  emulator: true,
};

const IPAD: Device = {
  id: 'sim-ipad',
  name: 'iPad Pro',
  platform: 'ios',
  platformType: 'ios',
  emulator: true,
};

const BOOTABLE: Bootable = {
  id: 'sim-16-pro',
  name: 'iPhone 16 Pro Max',
  platformType: 'ios',
  via: 'simctl',
  running: false,
};

test('expandProofMatrix crosses devices × appearance × text scale', () => {
  const { cells } = expandProofMatrix(
    { devices: ['iPhone SE', 'iPad Pro'], appearance: ['light', 'dark'], textScale: [1, 1.5] },
    [IPHONE, IPAD],
    [],
  );
  assert.equal(cells.length, 8);
  assert.ok(cells.every((c) => c.id === cellId(c)));
  assert.deepEqual(new Set(cells.map((c) => c.deviceName)), new Set(['iPhone SE', 'iPad Pro']));
});

test('expandProofMatrix defaults to the first connected device', () => {
  const { cells, boots } = expandProofMatrix({}, [IPHONE], [BOOTABLE]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].deviceId, IPHONE.id);
  assert.equal(boots.length, 0);
});

test('expandProofMatrix throws when no device is available', () => {
  assert.throws(
    () => expandProofMatrix({}, [], [BOOTABLE]),
    /no connected device/,
  );
});

test('resolveDeviceQuery matches bootables and marks needsBoot', () => {
  const resolved = resolveDeviceQuery('16 Pro', [], [BOOTABLE]);
  assert.equal(resolved.deviceId, BOOTABLE.id);
  assert.equal(resolved.needsBoot, true);
});

test('parseAppearanceList rejects unknown values', () => {
  assert.throws(() => parseAppearanceList('light,sepia'), /light or dark/);
});

test('textScaleToIosContentSize maps common scales to simctl buckets', () => {
  assert.equal(textScaleToIosContentSize(1), 'medium');
  assert.equal(textScaleToIosContentSize(1.5), 'extra-extra-large');
});

test('countFailedRequests counts transport errors and 5xx responses', () => {
  const rows: NetworkRequestSnapshot[] = [
    { id: '1', sessionId: 's', method: 'GET', uri: '/ok', startTime: 0, inProgress: false, statusCode: 200 },
    { id: '2', sessionId: 's', method: 'GET', uri: '/boom', startTime: 0, inProgress: false, statusCode: 500 },
    { id: '3', sessionId: 's', method: 'GET', uri: '/tls', startTime: 0, inProgress: false, error: 'tls' },
  ];
  assert.equal(countFailedRequests(rows), 2);
});

test('runCellChecks enforces running, noErrors, noFailedRequests and screenshot', () => {
  const logs: LogLine[] = [
    { at: 1, text: 'lib/main.dart:1:1: Error: oops', error: true },
    { at: 2, text: 'fine', error: false },
  ];
  const network: NetworkRequestSnapshot[] = [
    { id: '1', sessionId: 's', method: 'GET', uri: '/', startTime: 0, inProgress: false, statusCode: 503 },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'baton-proof-shot-'));
  const shot = join(dir, 'shot.png');
  writeFileSync(shot, Buffer.alloc(2048));

  const checks = runCellChecks(
    ['running', 'noErrors', 'noFailedRequests', 'screenshot'],
    { reachedRunning: false, logs, network, screenshotPath: shot },
  );
  assert.equal(checks.running?.pass, false);
  assert.equal(checks.noErrors?.pass, false);
  assert.equal(checks.noFailedRequests?.pass, false);
  assert.equal(checks.screenshot?.pass, true);

  const allowed = runCellChecks(
    ['noErrors'],
    { reachedRunning: true, logs, network: [], allowPatterns: [/oops/] },
  );
  assert.equal(allowed.noErrors?.pass, true);
});

test('formatCellLabel reads naturally in progress output', () => {
  assert.equal(
    formatCellLabel({ id: 'x', deviceId: '1', deviceName: 'iPhone 17 Pro', platformType: 'ios', appearance: 'dark' }),
    'iPhone 17 Pro · dark',
  );
});

test('summarizeNetwork groups by method+path with call counts and response times', () => {
  const stats = summarizeNetwork([
    { id: '1', sessionId: 's', method: 'GET', uri: 'https://api.test/v1/foo?a=1', startTime: 0, endTime: 100, durationMs: 120, statusCode: 200, inProgress: false },
    { id: '2', sessionId: 's', method: 'GET', uri: 'https://api.test/v1/foo?b=2', startTime: 0, endTime: 200, durationMs: 80, statusCode: 200, inProgress: false },
    { id: '3', sessionId: 's', method: 'POST', uri: 'https://api.test/v1/login', startTime: 0, endTime: 300, durationMs: 200, statusCode: 500, inProgress: false },
    { id: '4', sessionId: 's', method: 'GET', uri: 'https://api.test/v1/pending', startTime: 0, inProgress: true },
  ]);
  assert.equal(stats.length, 2);
  const getFoo = stats.find((s) => s.path === '/v1/foo')!;
  assert.equal(getFoo.count, 2);
  assert.equal(getFoo.avgMs, 100);
  assert.equal(getFoo.minMs, 80);
  assert.equal(getFoo.maxMs, 120);
  assert.equal(getFoo.failed, 0);
  const login = stats.find((s) => s.path === '/v1/login')!;
  assert.equal(login.count, 1);
  assert.equal(login.failed, 1);
  assert.equal(requestPath('https://x/y?z=1'), '/y');
});

test('writeProofBundle produces proof.json, summary.md, images/ and network-summary.json', () => {
  const bundlePath = mkdtempSync(join(tmpdir(), 'baton-proof-bundle-'));
  const spec: ProofCellSpec = {
    id: 'iphone-se-light-1-default',
    deviceId: 'sim-iphone-se',
    deviceName: 'iPhone SE',
    platformType: 'ios',
    appearance: 'light',
    textScale: 1,
  };
  const summary: ProofRunSummary = {
    id: '2026-proof-demo',
    target: 'demo',
    root: '/proj',
    startedAt: Date.now(),
    finishedAt: Date.now() + 1000,
    passed: false,
    cells: [{
      spec,
      status: 'failed',
      checks: {
        running: { pass: true },
        noErrors: { pass: false, message: '1 error line(s)' },
      },
      durationMs: 900,
    }],
    bundlePath,
  };
  const artifacts = new Map([
    [spec.id, {
      logs: [{ at: 1, text: 'err', error: true }],
      network: [
        { id: '1', sessionId: 's', method: 'GET', uri: 'https://api.test/health', startTime: 0, durationMs: 50, statusCode: 200, inProgress: false },
      ],
    }],
  ]);
  writeProofBundle(summary, artifacts);

  assert.ok(existsSync(join(bundlePath, 'proof.json')));
  assert.ok(existsSync(join(bundlePath, 'summary.md')));
  assert.ok(existsSync(join(bundlePath, 'network-summary.json')));
  const html = readFileSync(join(bundlePath, 'report.html'), 'utf8');
  assert.match(html, /iphone-se-light-1-default/);
  assert.ok(existsSync(join(bundlePath, 'cells', spec.id, 'logs.json')));
  assert.ok(existsSync(join(bundlePath, 'cells', spec.id, 'network-summary.json')));
});

test('runProof orchestrates cells in parallel and writes a bundle', async () => {
  const target: Target = {
    name: 'demo-app',
    kind: 'flutter',
    cwd: '/proj',
    source: 'launch.json',
    config: {
      name: 'demo-app',
      kind: 'flutter',
      cwd: '/proj',
      program: 'lib/main.dart',
      toolArgs: [],
      args: [],
    },
  };

  const sessions: Session[] = [];
  const host: ProofHost = {
    root: '/proj',
    matchTarget: (q) => (q === 'demo' ? target : undefined),
    matchTargetCandidates: () => [],
    listDevices: async () => ({
      connected: [IPHONE, IPAD],
      bootables: [],
    }),
    boot: async (id) => ({ ...IPHONE, id }),
    run: async (_t, deviceId) => {
      const session = {
        id: `proj/demo@${deviceId.slice(0, 8)}`,
        kind: 'flutter',
        name: 'demo-app',
        capabilities: new Set(['screenshot', 'network', 'stop'] as const),
        status: 'running' as const,
        recentLogs: () => [{ at: 1, text: 'ready', error: false }],
        snapshot: () => ({
          id: `proj/demo@${deviceId.slice(0, 8)}`,
          name: 'demo-app',
          kind: 'flutter',
          status: 'running' as const,
          target: deviceId,
          capabilities: ['screenshot', 'network', 'stop'],
          startedAt: Date.now(),
        }),
        stop: async () => {},
      };
      sessions.push(session as unknown as Session);
      return session as unknown as Session;
    },
    waitRunning: async () => true,
    waitStopped: async () => {},
    screenshot: async (_session, path) => {
      writeFileSync(path, Buffer.alloc(4096));
    },
    logs: (session) => session.recentLogs(),
    network: () => [],
    stop: async () => {},
    forget: () => {},
    exec: async () => ({ code: 0, stderr: '' }),
    onProgress: () => {},
  };

  const bundlePath = mkdtempSync(join(tmpdir(), 'baton-proof-run-'));
  const result = await runProof(host, {
    target: 'demo',
    devices: ['iPhone SE', 'iPad Pro'],
    appearance: ['light'],
    out: bundlePath,
    settleMs: 0,
    checks: ['running', 'noErrors', 'screenshot'],
  });

  assert.equal(result.cells.length, 2);
  assert.equal(result.passed, true);
  assert.ok(existsSync(join(bundlePath, 'report.html')));
  assert.equal(sessions.length, 2);
  rmSync(bundlePath, { recursive: true, force: true });
});
