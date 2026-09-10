import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'baton-engine-'));
process.env.BATON_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { WorkspaceEngine } = await import('../src/workspace/engine.ts');
const { parseManifest } = await import('../src/workspace/manifest.ts');
const { WorkspaceChoices } = await import('../src/workspace/choices.ts');
import type { LoadedManifest } from '../src/workspace/manifest.ts';
import type { WorkspaceHost } from '../src/workspace/host.ts';
import type { SessionSnapshot } from '../src/core/types.ts';

const ROOT = resolve('/repo');

/**
 * A host that records every side effect and lets a test decide the outcome.
 *
 * `fail` marks nodes whose readiness never arrives; `slow` holds a node's
 * readiness open so a test can observe what starts alongside it.
 */
function fakeHost() {
  const calls: string[] = [];
  const live = new Set<string>();
  const fail = new Set<string>();
  const holds = new Map<string, () => void>();
  let claimedBy: Record<string, { id: string; node: string }> = {};
  let probeFails = new Set<string>();

  const host: WorkspaceHost = {
    async runTarget(request) {
      calls.push(`runTarget:${request.workspace.node}:${JSON.stringify(request.env)}`);
      const id = `${request.workspace.node}-session`;
      live.add(id);
      return {
        id, name: request.name, kind: 'process', status: 'running', capabilities: [], startedAt: 0,
        url: `http://127.0.0.1/${request.workspace.node}`,
        workspace: claimedBy[request.workspace.node] ?? request.workspace,
      } satisfies SessionSnapshot;
    },
    async runCompose(request) {
      calls.push(`runCompose:${request.workspace.node}`);
      const id = `${request.workspace.node}-session`;
      live.add(id);
      return {
        session: { id, name: request.service, kind: 'compose', status: 'running', capabilities: [], startedAt: 0 },
        external: request.service === 'already-running',
      };
    },
    async waitFor(sessionId) {
      calls.push(`wait:${sessionId}`);
      const node = sessionId.replace('-session', '');
      if (fail.has(node)) throw new Error(`${node} never answered`);
      if (holds.has(node)) await new Promise<void>((r) => holds.set(node, r));
      return { url: `http://127.0.0.1/${node}` };
    },
    async probe(probe) {
      const key = 'http' in probe ? probe.http : `tcp:${probe.tcp}`;
      calls.push(`probe:${key}`);
      if (probeFails.has(key)) throw new Error(`${key} unreachable`);
    },
    async stop(sessionId) {
      calls.push(`stop:${sessionId}`);
      live.delete(sessionId);
    },
  };

  return {
    host, calls, live, fail, holds,
    claim(node: string, workspace: { id: string; node: string }) { claimedBy[node] = workspace; },
    failProbe(key: string) { probeFails.add(key); },
    healProbe(key: string) { probeFails.delete(key); },
  };
}

let manifestCounter = 0;

/**
 * A parsed manifest at a path unique to this call.
 *
 * Provider choices persist per manifest path, so two tests sharing one path
 * would leak `switch` decisions into each other.
 */
function loaded(nodes: Record<string, unknown>, defaults: Record<string, string> = {}, name = 'Delivery'): LoadedManifest {
  const root = join(ROOT, `w${manifestCounter += 1}`);
  return {
    manifest: parseManifest({ name, nodes, defaults }, root),
    manifestPath: join(root, 'baton.workspace.json'),
    root,
  };
}

const target = (name: string) => ({ target: { cwd: `./${name}`, name } });

test('a level starts in parallel, and the next level waits for it', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    db: { providers: { local: target('db') } },
    queue: { providers: { local: target('queue') } },
    api: { dependsOn: ['db', 'queue'], providers: { local: target('api') } },
  }));

  assert.deepEqual(Object.values(run.nodes).map((n) => n.status), ['ready', 'ready', 'ready']);
  const started = fake.calls.filter((c) => c.startsWith('runTarget')).map((c) => c.split(':')[1]);
  assert.deepEqual(started.slice(0, 2).sort(), ['db', 'queue']);
  assert.equal(started[2], 'api');
  // The API waited for both: its own start comes after both readiness waits.
  assert.ok(fake.calls.indexOf('runTarget:api:{}') > fake.calls.indexOf('wait:db-session'));
  assert.ok(fake.calls.indexOf('runTarget:api:{}') > fake.calls.indexOf('wait:queue-session'));
});

test('a dependency\'s exports reach its dependents as env, naming the live url', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  await engine.up(loaded({
    api: { providers: { local: target('api') }, exports: { API_URL: '${url}' } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  }));

  assert.ok(fake.calls.includes('runTarget:web:{"API_URL":"http://127.0.0.1/api"}'));
  assert.ok(fake.calls.includes('runTarget:api:{}'), 'a node with no dependencies gets no injected env');
});

test('a failed node names itself in every dependent it took down, and independent branches still start', async () => {
  const fake = fakeHost();
  fake.fail.add('api');
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    api: { providers: { local: target('api') } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
    mobile: { dependsOn: ['web'], providers: { local: target('mobile') } },
    docs: { providers: { local: target('docs') } },
  }));

  assert.equal(run.nodes.api.status, 'failed');
  assert.match(run.nodes.api.error!, /api never answered/);
  assert.equal(run.nodes.web.status, 'skipped');
  assert.match(run.nodes.web.error!, /api failed \(api never answered\)/);
  assert.equal(run.nodes.mobile.status, 'skipped');
  assert.match(run.nodes.mobile.error!, /web was skipped/);
  // One line: the culprit's full error is already shown on its own row.
  assert.ok(!run.nodes.web.error!.includes('\n'), 'attribution stays a single line');
  assert.equal(run.nodes.docs.status, 'ready', 'an unrelated branch is unaffected');
  assert.ok(!fake.calls.includes('runTarget:web:{}'), 'a skipped node is never started');
});

test('attribution quotes only the first line of a multi-line failure', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());
  fake.host.waitFor = async () => { throw new Error('cannot reach "url"\nFATAL: could not connect to postgres'); };

  const run = await engine.up(loaded({
    api: { providers: { local: target('api') } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  }));

  assert.match(run.nodes.api.error!, /FATAL: could not connect/, 'the failure keeps every line');
  assert.equal(run.nodes.web.error, 'api failed (cannot reach "url")');
});

test('up is idempotent: a second call starts only what is not already up', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());
  const manifest = loaded({
    api: { providers: { local: target('api') } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  });

  const first = await engine.up(manifest);
  await engine.restart(first.id, 'api'); // leaves web ready, api ready
  fake.calls.length = 0;

  const again = await engine.up(manifest);
  assert.equal(again.id, first.id, 'one run per manifest, not a new one each time');
  assert.deepEqual(fake.calls, [], 'nothing already ready is touched');
  assert.equal(engine.list().length, 1);
});

test('a node whose session was stopped elsewhere stops claiming to be ready', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());
  const manifest = loaded({
    api: { providers: { local: target('api') } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  });

  const run = await engine.up(manifest);
  assert.equal(run.nodes.api.status, 'ready');

  // Somebody ran `baton stop api`, or the process died. Nothing told the engine
  // directly; the session's own change event is the only signal there is.
  engine.noticeSession({ id: 'api-session', status: 'stopped' });
  assert.equal(run.nodes.api.status, 'stopped');
  assert.equal(run.nodes.api.sessionId, undefined);

  fake.calls.length = 0;
  await engine.up(manifest);
  assert.equal(run.nodes.api.status, 'ready');
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith('runTarget')),
    ['runTarget:api:{}'],
    'only the node that went away is restarted',
  );
});

test('a crashed node is failed, not merely stopped, and says so', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({ api: { providers: { local: target('api') } } }));
  engine.noticeSession({ id: 'api-session', status: 'failed' });

  assert.equal(run.nodes.api.status, 'failed');
  assert.match(run.nodes.api.error!, /exited unexpectedly/);
});

test('a session ending while a node is still starting leaves the readiness error intact', async () => {
  const fake = fakeHost();
  fake.fail.add('api');
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({ api: { providers: { local: target('api') } } }));
  engine.noticeSession({ id: 'api-session', status: 'failed' });

  assert.match(run.nodes.api.error!, /api never answered/, 'the useful reason survives');
});

test('down stops in reverse order and reports what it deliberately left alone', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    db: { providers: { staging: { remote: { url: 'postgres://staging/app' } } } },
    api: { dependsOn: ['db'], providers: { local: target('api') } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  }));
  fake.calls.length = 0;

  const result = await engine.down(run.id);

  assert.deepEqual(fake.calls, ['stop:web-session', 'stop:api-session']);
  assert.deepEqual(result.stopped, ['web', 'api']);
  assert.deepEqual(result.left, ['db'], 'a remote endpoint is never stopped');
  assert.equal(run.nodes.db.status, 'external');
  assert.equal(run.nodes.api.status, 'stopped');
  assert.equal(run.nodes.api.sessionId, undefined);
});

test('a remote node that does not answer fails the workspace rather than pretending', async () => {
  const fake = fakeHost();
  fake.failProbe('https://api.dev.example.com/health');
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    api: { providers: { dev: { remote: { url: 'https://api.dev.example.com' }, ready: { http: 'https://api.dev.example.com/health' } } } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  }));

  assert.equal(run.nodes.api.status, 'failed');
  assert.equal(run.nodes.web.status, 'skipped');
  assert.match(run.nodes.web.error!, /api failed/);
});

test('a reachable remote node is external: usable, and never stopped', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    api: { providers: { dev: { remote: { url: 'https://api.dev.example.com' }, ready: { http: 'https://api.dev.example.com/health' } } } },
  }));

  assert.equal(run.nodes.api.status, 'external');
  assert.equal(run.nodes.api.url, 'https://api.dev.example.com');
  assert.equal(run.nodes.api.readOnly, true);
  assert.equal(run.nodes.api.sessionId, undefined);
});

test('switching a node restarts its dependents and nothing else, and is remembered', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const manifest = loaded({
    db: {
      providers: {
        local: target('db'),
        staging: { remote: { url: 'postgres://staging/app' } },
      },
      exports: { DATABASE_URL: '${url}' },
    },
    api: { dependsOn: ['db'], providers: { local: target('api') } },
    docs: { providers: { local: target('docs') } },
  }, { db: 'local' });

  const run = await engine.up(manifest);
  fake.calls.length = 0;

  await engine.switch(run.id, 'db', 'staging');

  assert.equal(run.nodes.db.status, 'external');
  assert.equal(run.nodes.db.provider, 'staging');
  assert.deepEqual(fake.calls.filter((c) => c.startsWith('stop')), ['stop:db-session', 'stop:api-session']);
  assert.ok(fake.calls.includes('runTarget:api:{"DATABASE_URL":"postgres://staging/app"}'), 'the dependent picks up the new endpoint');
  assert.ok(!fake.calls.some((c) => c.includes('docs')), 'an unrelated node is left alone');
  assert.equal(new WorkspaceChoices().get(run.manifestPath).db, 'staging', 'this machine remembers the choice');
});

test('restart is scoped to one node unless it is asked to cascade', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    api: { providers: { local: target('api') } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  }));

  fake.calls.length = 0;
  await engine.restart(run.id, 'api');
  assert.deepEqual(fake.calls.filter((c) => c.startsWith('stop')), ['stop:api-session']);

  fake.calls.length = 0;
  await engine.restart(run.id, 'api', true);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith('stop')), ['stop:api-session', 'stop:web-session']);
});

test('a session another workspace already owns is adopted read-only, not stolen', async () => {
  const fake = fakeHost();
  fake.claim('api', { id: 'other-workspace', node: 'api' });
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({ api: { providers: { local: target('api') } } }));
  assert.equal(run.nodes.api.status, 'external');
  assert.equal(run.nodes.api.readOnly, true);

  fake.calls.length = 0;
  const result = await engine.down(run.id);
  assert.deepEqual(fake.calls, [], 'another workspace\'s session is not ours to stop');
  assert.deepEqual(result.left, ['api']);
  await assert.rejects(engine.restart(run.id, 'api'), /external|shared/);
});

test('a node that stops answering goes unhealthy, and comes back on its own', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    api: { providers: { local: { target: { cwd: './api', name: 'api' }, ready: { http: 'http://127.0.0.1:8080/health' } } } },
  }));
  assert.equal(run.nodes.api.status, 'ready');

  const changes: string[] = [];
  engine.on('change', (r) => changes.push(r.nodes.api.status));

  fake.failProbe('http://127.0.0.1:8080/health');
  await engine.checkHealth();
  assert.equal(run.nodes.api.status, 'unhealthy');
  assert.match(run.nodes.api.error!, /unreachable/);

  fake.healProbe('http://127.0.0.1:8080/health');
  await engine.checkHealth();
  assert.equal(run.nodes.api.status, 'ready');
  assert.deepEqual(changes, ['unhealthy', 'ready'], 'each flip is broadcast exactly once');

  // A steady state must not re-broadcast on every round.
  await engine.checkHealth();
  assert.deepEqual(changes, ['unhealthy', 'ready']);
});

test('a compose service that was already running is external and survives down', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    db: { providers: { docker: { compose: { file: './docker-compose.yml', service: 'already-running' } } } },
  }));

  assert.equal(run.nodes.db.status, 'external');
  const result = await engine.down(run.id);
  assert.deepEqual(result.left, ['db']);
  assert.deepEqual(result.stopped, []);
});

test('--node brings up one node and everything it needs, and nothing else', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  const run = await engine.up(loaded({
    db: { providers: { local: target('db') } },
    api: { dependsOn: ['db'], providers: { local: target('api') } },
    web: { dependsOn: ['api'], providers: { local: target('web') } },
  }), { nodes: ['api'] });

  assert.equal(run.nodes.db.status, 'ready');
  assert.equal(run.nodes.api.status, 'ready');
  assert.equal(run.nodes.web.status, 'pending', 'nothing downstream was asked for');
});

test('an invalid graph is refused before a single process starts', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  await assert.rejects(engine.up(loaded({
    api: { dependsOn: ['db'], providers: { local: target('api') } },
  })), /db/);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(engine.list(), []);
});

test('an ambiguous provider is refused before a single process starts', async () => {
  const fake = fakeHost();
  const engine = new WorkspaceEngine({ host: fake.host, healthIntervalMs: 60_000 });
  after(() => engine.dispose());

  await assert.rejects(engine.up(loaded({
    db: { providers: { local: target('db'), staging: { remote: { url: 'postgres://staging/app' } } } },
    api: { dependsOn: ['db'], providers: { local: target('api') } },
  })), /db offers/);
  assert.deepEqual(fake.calls, []);
});
