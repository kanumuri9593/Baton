import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore JavaScript example intentionally runs without a build step.
import { Delivery } from '../examples/workflow-lab/api/delivery.mjs';
test('delivery receipts survive retries and reset starts a new attempt', () => {
  const delivery = new Delivery();
  assert.equal(delivery.snapshot().receipt, null);
  const first = delivery.complete();
  assert.equal(first.status, 'Delivered');
  assert.deepEqual(delivery.complete(), first);
  assert.equal(delivery.reset().status, 'Ready');
  assert.notEqual(delivery.complete().receipt, first.receipt);
});
