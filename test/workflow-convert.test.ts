import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseWorkflow } from '../src/daemon/workflow.ts';
import { workflowToManifest, toWorkflowResult } from '../src/workspace/convert.ts';
import { topoLevels } from '../src/workspace/graph.ts';
import type { WorkspaceRun } from '../src/workspace/types.ts';

const plan = parseWorkflow({
  name: 'Demo',
  steps: [
    { name: 'API', cwd: resolve('/repo/api'), target: 'Delivery API', deviceId: 'sim-1' },
    { name: 'Web', cwd: resolve('/repo/web'), target: 'Delivery console', until: 'url', timeoutMs: 5000 },
  ],
});

test('a workflow becomes the graph where each step waits for the one before it', () => {
  const { manifest, root } = workflowToManifest(plan);

  assert.equal(manifest.name, 'Demo');
  assert.deepEqual(manifest.nodes.API.dependsOn, []);
  assert.deepEqual(manifest.nodes.Web.dependsOn, ['API']);
  // One step per level: that is what makes it sequential, and what makes a
  // failed step stop everything after it.
  assert.deepEqual(topoLevels(manifest), [['API'], ['Web']]);
  assert.equal(root, resolve('/repo'));
});

test('each step carries its target, device, readiness and timeout across unchanged', () => {
  const { manifest } = workflowToManifest(plan);
  const api = manifest.nodes.API.providers.local;
  const web = manifest.nodes.Web.providers.local;

  assert.deepEqual(api.target, { cwd: resolve('/repo/api'), name: 'Delivery API', device: 'sim-1' });
  assert.equal(api.ready, 'running');
  assert.equal(api.timeoutMs, 60000);
  assert.equal(web.ready, 'url');
  assert.equal(web.timeoutMs, 5000);
});

test('two different workflows never share one run', () => {
  const other = parseWorkflow({ ...plan, name: 'Other' });
  assert.notEqual(workflowToManifest(plan).manifestPath, workflowToManifest(other).manifestPath);
});

/** A run in whatever state the test needs, with the node fields the bridge reads. */
function run(nodes: Record<string, Partial<WorkspaceRun['nodes'][string]>>): WorkspaceRun {
  return {
    id: 'demo', name: 'Demo', manifestPath: 'workflow:Demo', root: '/repo', startedAt: 0,
    nodes: Object.fromEntries(Object.entries(nodes).map(([name, state]) => [name, {
      name, kind: 'other', provider: 'local', dependsOn: [], status: 'pending', readOnly: false, ...state,
    }])) as WorkspaceRun['nodes'],
  };
}

test('a successful run reads back in the shape run_workflow has always returned', () => {
  const result = toWorkflowResult(plan, run({
    API: { status: 'ready', sessionId: 'api/delivery', url: 'http://127.0.0.1:43121', elapsedMs: 120 },
    Web: { status: 'ready', sessionId: 'web/console', url: 'http://127.0.0.1:43122', elapsedMs: 90 },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.name, 'Demo');
  assert.deepEqual(result.steps.map((s) => s.name), ['API', 'Web']);
  assert.deepEqual(result.steps[0], {
    name: 'API', root: resolve('/repo/api'), status: 'ready',
    session: 'api/delivery', url: 'http://127.0.0.1:43121', elapsedMs: 120,
  });
  assert.match(result.next, /exercise the flow/);
});

test('a failed step keeps its session id for debugging, and the rest are skipped', () => {
  const result = toWorkflowResult(plan, run({
    API: { status: 'failed', sessionId: 'api/delivery', error: 'port already in use', elapsedMs: 40 },
    Web: { status: 'skipped', error: 'API failed (port already in use)' },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].session, 'api/delivery');
  assert.equal(result.steps[0].error, 'port already in use');
  assert.equal(result.steps[1].status, 'skipped');
  assert.equal(result.steps[1].error, undefined, 'the legacy shape reports the reason on the failure only');
  assert.match(result.next, /Inspect the failed step/);
});

test('a node adopted from elsewhere still counts as ready', () => {
  const result = toWorkflowResult(plan, run({
    API: { status: 'external', url: 'https://api.dev.example.com' },
    Web: { status: 'ready', sessionId: 'web/console' },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].status, 'ready');
});
