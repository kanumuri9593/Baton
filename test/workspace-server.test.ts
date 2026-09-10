import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = mkdtempSync(join(tmpdir(), 'baton-workspace-server-'));
process.env.BATON_HOME = state;
const { LaunchDaemon } = await import('../src/daemon/server.ts');
import type { WorkspaceRun } from '../src/workspace/types.ts';

/**
 * A two-node lab on real ports: an API that reports its own URL, and a console
 * that proxies whatever `API_URL` it was handed. That second part is the point
 * — it is how the test can tell that exports actually reached the child.
 */
function lab(root: string): string {
  mkdirSync(root, { recursive: true });

  const api = join(root, 'api');
  mkdirSync(join(api, '.vscode'), { recursive: true });
  const apiCode = `const s=require('node:http').createServer((q,r)=>{`
    + `if(q.url==='/health'){r.writeHead(200);return r.end('ok')}`
    + `r.writeHead(200);r.end('api')})`
    + `.listen(0,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port)})`;
  writeFileSync(join(api, '.vscode/launch.json'), JSON.stringify({
    configurations: [{ name: 'api', type: 'node', batonKind: 'web-dev', runtimeExecutable: process.execPath, runtimeArgs: ['-e', apiCode] }],
  }));

  const console_ = join(root, 'console');
  mkdirSync(join(console_, '.vscode'), { recursive: true });
  const consoleCode = `const s=require('node:http').createServer((q,r)=>{`
    + `r.writeHead(200);r.end(process.env.API_URL||'NO_API_URL')})`
    + `.listen(0,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port)})`;
  writeFileSync(join(console_, '.vscode/launch.json'), JSON.stringify({
    configurations: [{ name: 'console', type: 'node', batonKind: 'web-dev', runtimeExecutable: process.execPath, runtimeArgs: ['-e', consoleCode] }],
  }));

  writeFileSync(join(root, 'baton.workspace.json'), JSON.stringify({
    name: 'Lab',
    nodes: {
      api: { kind: 'backend', providers: { local: { target: { cwd: './api', name: 'api' }, ready: 'url', timeoutMs: 10000 } }, exports: { API_URL: '${url}' } },
      console: { kind: 'web', dependsOn: ['api'], providers: { local: { target: { cwd: './console', name: 'console' }, ready: 'url', timeoutMs: 10000 } } },
    },
  }));
  return root;
}

test('a workspace comes up in order, wires exports into the child, and puts itself down', async (t) => {
  const daemon = new LaunchDaemon('test', { workspaceHealthIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }); });
  const root = lab(join(state, 'lab'));

  const run = await daemon.handle({ method: 'workspaceUp', params: { cwd: root } }) as WorkspaceRun;

  assert.equal(run.name, 'Lab');
  assert.equal(run.nodes.api.status, 'ready');
  assert.equal(run.nodes.console.status, 'ready');
  assert.ok(run.nodes.api.url, 'the API reported a URL');

  // The console answers with the API_URL it was given: proof the export arrived.
  const seen = await (await fetch(run.nodes.console.url!)).text();
  assert.equal(seen, run.nodes.api.url, 'the console received the API it depends on');

  // Sessions carry their workspace, and the workflow name clients already group by.
  const sessions = daemon.registry.snapshots();
  assert.deepEqual(
    sessions.map((s) => s.workspace?.node).sort(),
    ['api', 'console'],
  );
  assert.deepEqual([...new Set(sessions.map((s) => s.workflow))], ['Lab']);

  const second = await daemon.handle({ method: 'workspaceUp', params: { cwd: root } }) as WorkspaceRun;
  assert.equal(second.id, run.id, 'a second up is the same run');
  assert.deepEqual(daemon.registry.snapshots().map((s) => s.id).sort(), sessions.map((s) => s.id).sort(), 'and starts nothing new');

  const down = await daemon.handle({ method: 'workspaceDown', params: { id: run.id } }) as { stopped: string[]; left: string[] };
  assert.deepEqual(down.stopped, ['console', 'api'], 'reverse dependency order');
  assert.deepEqual(down.left, []);
  for (const snapshot of daemon.registry.snapshots()) {
    assert.notEqual(snapshot.status, 'running');
  }
});

test('a workspace node can be pointed at a remote endpoint, and its dependents follow', async (t) => {
  const daemon = new LaunchDaemon('test', { workspaceHealthIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => { await daemon.close(); });
  const root = lab(join(state, 'switchable'));

  // Add a second provider for the API: a remote endpoint that is really this test.
  const { createServer } = await import('node:http');
  const upstream = await new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = createServer((_q, r) => { r.writeHead(200); r.end('remote'); });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
  t.after(() => upstream.close());

  const manifest = JSON.parse(readFileSync(join(root, 'baton.workspace.json'), 'utf8'));
  manifest.nodes.api.providers.dev = { remote: { url: upstream.url }, ready: { http: `${upstream.url}/health` } };
  manifest.defaults = { api: 'local' };
  writeFileSync(join(root, 'baton.workspace.json'), JSON.stringify(manifest));

  const run = await daemon.handle({ method: 'workspaceUp', params: { cwd: root } }) as WorkspaceRun;
  assert.equal(run.nodes.api.status, 'ready');

  const switched = await daemon.handle({
    method: 'workspaceSwitch', params: { id: run.id, node: 'api', provider: 'dev' },
  }) as WorkspaceRun;

  assert.equal(switched.nodes.api.status, 'external');
  assert.equal(switched.nodes.api.url, upstream.url);
  assert.equal(switched.nodes.console.status, 'ready', 'the dependent came back up');
  assert.equal(
    await (await fetch(switched.nodes.console.url!)).text(),
    upstream.url,
    'the console was restarted pointing at the new endpoint',
  );

  const down = await daemon.handle({ method: 'workspaceDown', params: { id: run.id } }) as { stopped: string[]; left: string[] };
  assert.deepEqual(down.stopped, ['console']);
  assert.deepEqual(down.left, ['api'], 'a remote endpoint is reported, not stopped');
  assert.equal(await (await fetch(upstream.url)).text(), 'remote', 'and is genuinely untouched');
});

test('an invalid manifest is refused before anything starts, naming the file and the reason', async (t) => {
  const daemon = new LaunchDaemon('test', { workspaceHealthIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => { await daemon.close(); });

  const root = join(state, 'broken');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'baton.workspace.json'), JSON.stringify({
    name: 'Broken',
    nodes: { api: { dependsOn: ['ghost'], providers: { local: { target: { cwd: './api', name: 'api' } } } } },
  }));

  await assert.rejects(
    daemon.handle({ method: 'workspaceUp', params: { cwd: root } }),
    /ghost/,
  );
  assert.deepEqual(daemon.registry.snapshots(), []);
  assert.deepEqual(daemon.workspaces.list(), []);
});

test('a project root with a manifest describes its workspace, deterministically', async (t) => {
  const daemon = new LaunchDaemon('test', { workspaceHealthIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => { await daemon.close(); });
  const root = lab(join(state, 'described'));

  const added = await daemon.handle({ method: 'addProject', params: { path: root } }) as { workspace?: { name: string; nodes: string[]; id?: string } };
  assert.equal(added.workspace?.name, 'Lab');
  assert.deepEqual(added.workspace?.nodes, ['api', 'console']);
  assert.equal(added.workspace?.id, undefined, 'nothing is up yet');

  assert.notEqual((added as { needsConfig?: boolean }).needsConfig, true, 'a manifest is something to offer');

  const again = await daemon.handle({ method: 'addProject', params: { path: root } }) as typeof added;
  assert.deepEqual(again.workspace, added.workspace, 'the workspace block carries no timestamps');

  const run = await daemon.handle({ method: 'workspaceUp', params: { cwd: root } }) as WorkspaceRun;
  const live = await daemon.handle({ method: 'addProject', params: { path: root } }) as { workspace?: { id?: string } };
  assert.equal(live.workspace?.id, run.id, 'once up, the project points at the run');
  await daemon.handle({ method: 'workspaceDown', params: { id: run.id } });
});

test('a workspace and a legacy workflow can share a root without stealing each other\'s sessions', async (t) => {
  const daemon = new LaunchDaemon('test', { workspaceHealthIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => { await daemon.close(); });
  const root = lab(join(state, 'shared-root'));

  const run = await daemon.handle({ method: 'workspaceUp', params: { cwd: root } }) as WorkspaceRun;
  const workflow = await daemon.handle({
    method: 'workflowRun',
    params: {
      name: 'Legacy',
      steps: [{ name: 'api', cwd: join(root, 'api'), target: 'api', until: 'url', timeoutMs: 10000 }],
    },
  }) as { ok: boolean; steps: { status: string }[] };

  // The workflow names the same target, so it finds the workspace's live
  // session. Adopting it is right; quietly taking it over would not be.
  assert.equal(workflow.ok, true);
  const status = await daemon.handle({ method: 'workspaceStatus', params: {} }) as { workspaces: WorkspaceRun[] };
  assert.equal(status.workspaces.length, 2, 'both runs are listed, so a client can disambiguate');
  const legacy = status.workspaces.find((w) => w.name === 'Legacy')!;
  assert.equal(legacy.nodes.api.readOnly, true, 'a session another workspace owns is read-only here');
  assert.equal(legacy.nodes.api.status, 'external');

  const down = await daemon.handle({ method: 'workspaceDown', params: { id: legacy.id } }) as { stopped: string[]; left: string[] };
  assert.deepEqual(down.stopped, [], 'and putting the workflow down leaves it alone');
  assert.deepEqual(down.left, ['api']);
  assert.equal(daemon.registry.get(run.nodes.api.sessionId!)?.status, 'running', 'the workspace still has its API');

  await daemon.handle({ method: 'workspaceDown', params: { id: run.id } });
});

test('every node change is pushed to connected clients as the whole run', async (t) => {
  const daemon = new LaunchDaemon('test', { workspaceHealthIntervalMs: 60_000 });
  const handshake = await daemon.listen();
  t.after(async () => { await daemon.close(); });
  const root = lab(join(state, 'pushed'));

  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${handshake.port}/?token=${handshake.token}`);
  const events: any[] = [];
  socket.on('message', (raw: Buffer) => events.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve) => socket.on('open', () => resolve()));
  t.after(() => socket.close());

  const run = await daemon.handle({ method: 'workspaceUp', params: { cwd: root } }) as WorkspaceRun;
  await new Promise((resolve) => setTimeout(resolve, 50));

  const hello = events.find((e) => e.event === 'hello');
  assert.deepEqual(hello.workspaces, [], 'hello carries workspaces, empty before anything is up');

  const pushed = events.filter((e) => e.event === 'workspace');
  assert.ok(pushed.length > 0, 'node changes are pushed');
  assert.equal(pushed.at(-1).run.id, run.id);
  assert.equal(pushed.at(-1).run.nodes.console.status, 'ready');

  await daemon.handle({ method: 'workspaceDown', params: { id: run.id } });
});
