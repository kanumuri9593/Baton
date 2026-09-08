import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, runWorkflow, type WorkflowHost } from '../src/daemon/workflow.ts';
import type { SessionSnapshot } from '../src/core/types.ts';
import { resolve } from 'node:path';
const plan = {name:'Demo',steps:[{name:'API',cwd:resolve('api'),target:'api'},{name:'Web',cwd:resolve('web'),target:'web',until:'url'}]};

test('workflow launches in readiness order and returns only compact results', async () => {
  const order: string[] = [];
  const result = await runWorkflow({
    run: async (s) => {order.push('run '+s.name); return {id:s.name, env:'private', logs:['long output']} as unknown as SessionSnapshot;},
    wait: async (id) => {order.push('wait '+id); return {url:'http://localhost:1234'};},
  }, plan);
  assert.deepEqual(order,['run API','wait API','run Web','wait Web']);
  assert.ok(result.ok);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(result.steps[1].url,'http://localhost:1234');
});

test('workflow retains failed session id and skips dependents', async () => {
  const result = await runWorkflow({
    run: async (s) => ({id:s.name}) as SessionSnapshot,
    wait: async () => {throw new Error('port already in use');},
  }, plan);
  assert.equal(result.ok,false);
  assert.equal(result.steps[0].session,'API');
  assert.equal(result.steps[0].error,'port already in use');
  assert.equal(result.steps[1].status,'skipped');
});

test('all steps are validated before executing any target', async () => {
  let calls = 0;
  const host = {run:async()=>{calls++;},wait:async()=>{}} as unknown as WorkflowHost;
  await assert.rejects(runWorkflow(host,{...plan,steps:[plan.steps[0],{...plan.steps[1],timeoutMs:-1}]}));
  await assert.rejects(runWorkflow(host,{...plan,steps:[plan.steps[0],plan.steps[0]]}),/Duplicate/);
  assert.equal(calls,0);
});

test('workflow file paths resolve relative to the file; RPC requires absolute paths', () => {
  const relative = {name:'Demo',steps:[{name:'API',cwd:'api',target:'api',checkout:'../worktree'}]};
  assert.throws(()=>parseWorkflow(relative),/absolute/);
  const parsed = parseWorkflow(relative,resolve('examples'));
  assert.equal(parsed.steps[0].cwd,resolve('examples/api'));
  assert.equal(parsed.steps[0].checkout,resolve('worktree'));
});
