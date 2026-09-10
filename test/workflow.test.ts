import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '../src/daemon/workflow.ts';
import { resolve } from 'node:path';

const plan = {
  name: 'Demo',
  steps: [
    { name: 'API', cwd: resolve('api'), target: 'api' },
    { name: 'Web', cwd: resolve('web'), target: 'web', until: 'url' },
  ],
};

test('every step is validated, so a bad plan never starts a first process', () => {
  assert.throws(() => parseWorkflow({ ...plan, steps: [plan.steps[0], { ...plan.steps[1], timeoutMs: -1 }] }));
  assert.throws(() => parseWorkflow({ ...plan, steps: [plan.steps[0], plan.steps[0]] }), /Duplicate/);
  assert.throws(() => parseWorkflow({ ...plan, steps: [] }));
});

test('defaults are filled in so every step has an explicit readiness and timeout', () => {
  const parsed = parseWorkflow(plan);
  assert.equal(parsed.steps[0].until, 'running');
  assert.equal(parsed.steps[1].until, 'url');
  assert.equal(parsed.steps[0].timeoutMs, 60000);
});

test('workflow file paths resolve relative to the file; RPC requires absolute paths', () => {
  const relative = { name: 'Demo', steps: [{ name: 'API', cwd: 'api', target: 'api', checkout: '../worktree' }] };
  assert.throws(() => parseWorkflow(relative), /absolute/);
  const parsed = parseWorkflow(relative, resolve('examples'));
  assert.equal(parsed.steps[0].cwd, resolve('examples/api'));
  assert.equal(parsed.steps[0].checkout, resolve('worktree'));
});

test('branch and checkout are mutually exclusive', () => {
  assert.throws(() => parseWorkflow({
    name: 'Demo',
    steps: [{ name: 'API', cwd: resolve('api'), target: 'api', branch: 'main', checkout: resolve('wt') }],
  }));
});
