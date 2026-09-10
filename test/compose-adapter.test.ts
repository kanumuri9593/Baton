import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ComposeSession, DOCKER_MISSING_HINT, COMPOSE_MISSING_HINT } from '../src/adapters/compose.ts';
import type { Session } from '../src/core/types.ts';

/** Just enough ChildProcess for the adapter: two output streams and an exit. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null));
    return true;
  }

  say(text: string, error = false): void {
    (error ? this.stderr : this.stdout).emit('data', Buffer.from(text));
  }

  /** Output and exit both land after the caller has subscribed, as a real child's would. */
  finish(code: number, stdout = '', stderr = ''): void {
    queueMicrotask(() => {
      if (stdout) this.say(stdout);
      if (stderr) this.say(stderr, true);
      this.emit('exit', code);
    });
  }
}

type Script = {
  /** Keyed by the subcommand: 'ps', 'up', 'stop', 'logs'. */
  [command: string]: { code?: number; stdout?: string; stderr?: string; spawnError?: NodeJS.ErrnoException };
};

/** A spawn stand-in that records argv and answers from a script. */
function scripted(script: Script) {
  const argv: string[][] = [];
  const children: Record<string, FakeChild> = {};
  const spawnFn = ((command: string, args: string[]) => {
    argv.push([command, ...args]);
    const child = new FakeChild();
    // args are ['compose', '-f', <file>, <subcommand>, ...]
    const key = args[3];
    children[key] = child;
    const answer = script[key] ?? {};
    if (answer.spawnError) queueMicrotask(() => child.emit('error', answer.spawnError));
    else if (key !== 'logs') child.finish(answer.code ?? 0, answer.stdout, answer.stderr);
    else if (answer.code !== undefined) child.finish(answer.code, answer.stdout, answer.stderr);
    return child;
  }) as never;
  return { spawnFn, argv, children };
}

function session(spawnFn: never): ComposeSession & Session {
  return ComposeSession.forService({
    file: '/repo/infra/docker-compose.yml',
    service: 'postgres',
    idRoot: '/repo',
    spawnFn,
  }) as ComposeSession & Session;
}

/** Resolves on the session's next settled status. */
function settles(target: ComposeSession, want: string): Promise<void> {
  return new Promise((resolve) => {
    if (target.status === want) return resolve();
    target.on('change', () => { if (target.status === want) resolve(); });
  });
}

test('a service that is not running is brought up, then followed, with exact compose argv', async () => {
  const { spawnFn, argv } = scripted({ ps: { code: 0, stdout: '' }, up: { code: 0 } });
  const compose = session(spawnFn);
  compose.start();
  await settles(compose, 'running');

  assert.equal(compose.external, false);
  assert.deepEqual(argv[0], ['docker', 'compose', '-f', '/repo/infra/docker-compose.yml', 'ps', '--format', 'json', '--status', 'running', 'postgres']);
  assert.deepEqual(argv[1], ['docker', 'compose', '-f', '/repo/infra/docker-compose.yml', 'up', '-d', 'postgres']);
  assert.deepEqual(argv[2], ['docker', 'compose', '-f', '/repo/infra/docker-compose.yml', 'logs', '-f', '--no-log-prefix', 'postgres']);
  assert.deepEqual([...compose.capabilities].sort(), ['restartProcess', 'stop']);
});

test('a container that was already running is external: never started, never stopped, still followed', async () => {
  const { spawnFn, argv } = scripted({ ps: { code: 0, stdout: '{"Name":"infra-postgres-1","State":"running"}\n' } });
  const compose = session(spawnFn);
  compose.start();
  await settles(compose, 'running');

  assert.equal(compose.external, true);
  assert.deepEqual(argv.map((a) => a[4]), ['ps', 'logs'], 'no up, and no stop');
  assert.deepEqual([...compose.capabilities], [], 'an external container offers no stop button');
  assert.match(compose.recentLogs().map((l) => l.text).join('\n'), /already running; Baton will not stop it/);

  await compose.stop();
  assert.deepEqual(argv.map((a) => a[4]), ['ps', 'logs'], 'stop must not touch somebody else\'s container');
  assert.equal(compose.status, 'stopped');
});

test('a failing up fails the session with what docker actually said', async () => {
  const { spawnFn, argv } = scripted({
    ps: { code: 0, stdout: '' },
    up: { code: 1, stderr: 'no such service: postgres' },
  });
  const compose = session(spawnFn);
  compose.start();
  await settles(compose, 'failed');

  assert.match(compose.recentLogs().map((l) => l.text).join('\n'), /no such service: postgres/);
  assert.deepEqual(argv.map((a) => a[4]), ['ps', 'up'], 'nothing is followed when nothing came up');
});

test('a missing docker says so, and says what to do about it', async () => {
  const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
  const { spawnFn } = scripted({ ps: { spawnError: enoent } });
  const compose = session(spawnFn);
  compose.start();
  await settles(compose, 'failed');

  const logs = compose.recentLogs().map((l) => l.text).join('\n');
  assert.equal(logs, DOCKER_MISSING_HINT);
  assert.match(logs, /Compose v2/);
  assert.match(logs, /baton switch/);
});

test('a docker without the Compose plugin is explained, not passed through as flag noise', async () => {
  // What a plain docker CLI with no compose plugin really says.
  const { spawnFn, argv } = scripted({
    ps: { code: 125, stderr: "unknown shorthand flag: 'f' in -f\nUsage:  docker [OPTIONS] COMMAND [ARG...]" },
  });
  const compose = session(spawnFn);
  compose.start();
  await settles(compose, 'failed');

  const logs = compose.recentLogs().map((l) => l.text).join('\n');
  assert.match(logs, /Compose v2/, 'the hint has to name what is missing');
  assert.match(logs, /baton switch/, 'and what to do instead');
  assert.match(logs, /unknown shorthand flag/, 'without hiding what docker actually said');
  assert.deepEqual(argv.map((a) => a[4]), ['ps'], 'nothing is started against a docker that cannot');
  assert.ok(COMPOSE_MISSING_HINT.length > 0);
});

test('the container dying is noticed through the log stream, not through up -d', async () => {
  const { spawnFn, children } = scripted({ ps: { code: 0, stdout: '' }, up: { code: 0 } });
  const compose = session(spawnFn);
  compose.start();
  await settles(compose, 'running');

  const exited = new Promise((resolve) => compose.on('exit', resolve));
  children.logs.emit('exit', 0);
  await exited;

  assert.equal(compose.status, 'failed');
  assert.match(compose.recentLogs().map((l) => l.text).join('\n'), /no longer running/);
});

test('stopping a container Baton started runs compose stop and ends the log follower', async () => {
  const { spawnFn, argv, children } = scripted({ ps: { code: 0, stdout: '' }, up: { code: 0 }, stop: { code: 0 } });
  const compose = session(spawnFn);
  compose.start();
  await settles(compose, 'running');

  await compose.stop();

  assert.equal(compose.status, 'stopped');
  assert.ok(children.logs.killed, 'the log follower must not outlive the session');
  assert.deepEqual(argv.at(-1), ['docker', 'compose', '-f', '/repo/infra/docker-compose.yml', 'stop', 'postgres']);
});
