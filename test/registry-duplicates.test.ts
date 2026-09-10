import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../src/core/registry.ts';
import type { Session } from '../src/core/types.ts';
import type { Target } from '../src/config/detect.ts';

const registry = new SessionRegistry();
after(async () => { await registry.stopAll(); });

/** A target whose child runs until it is stopped, so the session stays live. */
function longRunning(cwd: string, name = 'api'): Target {
  return {
    name, kind: 'process', source: 'launch.json', cwd,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    config: { name, kind: 'process', cwd, toolArgs: [], args: [] },
  };
}

/** A target that prints its marker and exits, so the session reaches a terminal state. */
function shortLived(cwd: string, marker: string, name = 'api'): Target {
  return {
    name, kind: 'process', source: 'launch.json', cwd,
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(marker)})`],
    config: { name, kind: 'process', cwd, toolArgs: [], args: [] },
  };
}

function project(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `baton-dupe-${prefix}-`));
}

async function exited(session: Session): Promise<void> {
  if (session.status === 'stopped' || session.status === 'failed') return;
  await new Promise<void>((resolve) => session.on('exit', () => resolve()));
}

test('a second run of a live target is still refused by default', async () => {
  const cwd = project('refuse');
  const first = await registry.run(longRunning(cwd));
  await assert.rejects(registry.run(longRunning(cwd)), /already running/);
  await first.stop();
});

test('ifRunning reuse hands back the live session instead of failing, and starts nothing new', async () => {
  const cwd = project('reuse');
  const first = await registry.run(longRunning(cwd));
  const again = await registry.run(longRunning(cwd), { ifRunning: 'reuse' });

  assert.equal(again, first, 'the same session object, not a second process');
  assert.equal(registry.list().filter((s) => s.id === first.id).length, 1);
  await first.stop();
});

test('a finished session with the same id is evicted so a restart can take its place', async () => {
  const cwd = project('evict');
  const forgotten: string[] = [];
  registry.on('forgotten', (id: string) => forgotten.push(id));

  const first = await registry.run(shortLived(cwd, 'FIRST'));
  await exited(first);

  const second = await registry.run(shortLived(cwd, 'SECOND'));
  await exited(second);

  assert.equal(second.id, first.id);
  assert.notEqual(second, first);
  assert.deepEqual(forgotten, [first.id], 'listeners are told the old row is gone');
  assert.equal(registry.list().filter((s) => s.id === first.id).length, 1);
  assert.match(second.recentLogs().map((l) => l.text).join(''), /SECOND/);
});

test('a workspace stamps its node onto the session snapshot, alongside the workflow name', async () => {
  const cwd = project('stamp');
  const session = await registry.run(longRunning(cwd), {
    workflow: 'Delivery',
    workspace: { id: 'ws-1', node: 'api' },
  });

  assert.deepEqual(session.snapshot().workspace, { id: 'ws-1', node: 'api' });
  assert.equal(session.snapshot().workflow, 'Delivery');
  await session.stop();
});
