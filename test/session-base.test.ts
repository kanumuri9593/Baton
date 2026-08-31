import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { BaseSession, sessionId } from '../src/core/session-base.ts';
import type { OperationResult } from '../src/core/types.ts';
import { WebDevSession } from '../src/adapters/web-dev.ts';
import { ProcessSession, type ProcessSessionOptions } from '../src/adapters/process.ts';

/** The smallest possible concrete session, for exercising BaseSession itself. */
class FakeSession extends BaseSession {
  readonly kind = 'fake';

  start(): void {
    this.status = 'running';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  hotReload(): Promise<OperationResult> {
    return Promise.resolve({ code: 0 });
  }
}

test('grantCapability adds the capability and emits change', () => {
  const s = new FakeSession('fake/one', 'one', ['stop']);
  assert.equal(s.capabilities.has('network'), false);

  let changed = 0;
  s.on('change', () => changed++);

  s.grantCapability('network');

  assert.equal(s.capabilities.has('network'), true);
  assert.equal(changed, 1, 'granting a capability must emit change so snapshots rebroadcast');
});

test('granting a capability twice is idempotent', () => {
  const s = new FakeSession('fake/two', 'two', ['stop']);
  s.grantCapability('network');
  s.grantCapability('network');
  assert.equal([...s.capabilities].filter((c) => c === 'network').length, 1);
});

test('two instances of the same adapter class do not share capability mutations', () => {
  const a = WebDevSession.create('dev', { command: 'true', args: [], cwd: '/tmp/dev-a' });
  const b = WebDevSession.create('dev', { command: 'true', args: [], cwd: '/tmp/dev-b' });

  assert.notEqual(a.capabilities, b.capabilities, 'each session must own its own capability set');

  a.grantCapability('network');

  assert.equal(a.capabilities.has('network'), true);
  assert.equal(
    b.capabilities.has('network'),
    false,
    'granting a capability on one session must not leak to another session of the same class',
  );
});

test('two instances of the same adapter class still start with the same base capabilities', () => {
  const a = WebDevSession.create('dev', { command: 'true', args: [], cwd: '/tmp/dev-c' });
  const b = WebDevSession.create('dev', { command: 'true', args: [], cwd: '/tmp/dev-d' });
  assert.deepEqual([...a.capabilities].sort(), [...b.capabilities].sort());
});

test('snapshots include a capability granted at runtime', () => {
  const s = new FakeSession(sessionId('/tmp/proj', 'fake'), 'fake', ['stop']);
  s.grantCapability('network');
  assert.ok(s.snapshot().capabilities.includes('network'));
});

test('snapshots include pid when the session has one, and omit it otherwise', () => {
  const s = new FakeSession(sessionId('/tmp/proj', 'fake'), 'fake', ['stop']);
  assert.equal(s.snapshot().pid, undefined);
  s.pid = 88;
  assert.equal(s.snapshot().pid, 88);
});

test('ProcessSession records the child pid on start and clears it on exit', async () => {
  const options: ProcessSessionOptions = {
    command: 'fake',
    args: [],
    cwd: tmpdir(),
    spawnFn: (() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        exitCode: number | null;
        kill: () => void;
      };
      child.pid = 4321;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {
        child.exitCode = 0;
        child.emit('exit', 0);
      };
      return child;
    }) as unknown as ProcessSessionOptions['spawnFn'],
  };
  const s = ProcessSession.forCommand('fake', options);
  s.start();
  assert.equal(s.snapshot().pid, 4321);
  await s.stop();
  assert.equal(s.snapshot().pid, undefined);
});
