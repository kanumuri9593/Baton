import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLog, matchNetwork, methodGroup } from '../src/hud/assets/filters.js';

const log = (text: string, error = false) => ({ text, error });

test('errors chip keeps only error lines', () => {
  const filter = { level: 'errors' as const, text: '' };
  assert.equal(matchLog(log('ok'), filter), false);
  assert.equal(matchLog(log('boom', true), filter), true);
});

test('not-errors chip drops error lines', () => {
  const filter = { level: 'ok' as const, text: '' };
  assert.equal(matchLog(log('ok'), filter), true);
  assert.equal(matchLog(log('boom', true), filter), false);
});

test('log text filter is case-insensitive and accepts a regex', () => {
  const filter = { level: 'all' as const, text: 'FAIL' };
  assert.equal(matchLog(log('failed to compile'), filter), true);
  assert.equal(matchLog(log('all good'), filter), false);
  assert.equal(matchLog(log('Error: x'), { level: 'all', text: '^error' }), true);
});

test('an invalid log regex falls back to substring match rather than matching nothing', () => {
  assert.equal(matchLog(log('weird (thing)'), { level: 'all', text: '(' }), true);
  assert.equal(matchLog(log('nope'), { level: 'all', text: '(' }), false);
});

const req = (over: Record<string, unknown> = {}) => ({
  id: '1',
  method: 'GET',
  uri: 'https://api.test/v1/orders',
  statusCode: 200,
  inProgress: false,
  ...over,
});

test('status chips: ok, redirects, errors, in-flight', () => {
  const ok = { status: 'ok' as const, methods: [], hideNoise: false, text: '' };
  assert.equal(matchNetwork(req({ statusCode: 204 }), ok), true);
  assert.equal(matchNetwork(req({ statusCode: 404 }), ok), false);

  const redir = { ...ok, status: 'redirects' as const };
  assert.equal(matchNetwork(req({ statusCode: 302 }), redir), true);
  assert.equal(matchNetwork(req({ statusCode: 200 }), redir), false);

  const errors = { ...ok, status: 'errors' as const };
  assert.equal(matchNetwork(req({ statusCode: 500 }), errors), true);
  assert.equal(matchNetwork(req({ statusCode: 404 }), errors), true);
  assert.equal(matchNetwork(req({ error: 'timeout', statusCode: undefined }), errors), true);
  assert.equal(matchNetwork(req({ statusCode: 200 }), errors), false);

  const inflight = { ...ok, status: 'inflight' as const };
  assert.equal(matchNetwork(req({ inProgress: true, statusCode: undefined }), inflight), true);
  assert.equal(matchNetwork(req({ inProgress: false }), inflight), false);
});

test('method chips are multi-select and PUT/PATCH share a group', () => {
  const filter = { status: 'all' as const, methods: ['GET', 'PUT/PATCH'], hideNoise: false, text: '' };
  assert.equal(matchNetwork(req({ method: 'GET' }), filter), true);
  assert.equal(matchNetwork(req({ method: 'PUT' }), filter), true);
  assert.equal(matchNetwork(req({ method: 'PATCH' }), filter), true);
  assert.equal(matchNetwork(req({ method: 'POST' }), filter), false);
  assert.equal(methodGroup('PATCH'), 'PUT/PATCH');
});

test('hide-noise drops images, fonts and analytics hosts', () => {
  const filter = { status: 'all' as const, methods: [], hideNoise: true, text: '' };
  assert.equal(matchNetwork(req({ uri: 'https://cdn.test/logo.png' }), filter), false);
  assert.equal(matchNetwork(req({ uri: 'https://cdn.test/inter.woff2' }), filter), false);
  assert.equal(matchNetwork(req({ uri: 'https://www.google-analytics.com/g/collect' }), filter), false);
  assert.equal(matchNetwork(req({ uri: 'https://api.test/v1/orders' }), filter), true);
});

test('network text filter matches method or URI and invalid regex is a substring', () => {
  const filter = { status: 'all' as const, methods: [], hideNoise: false, text: 'post' };
  assert.equal(matchNetwork(req({ method: 'POST', uri: 'https://x.test/' }), filter), true);
  assert.equal(matchNetwork(req({ uri: 'https://api.test/v2/login' }), filter), false);
  assert.equal(matchNetwork(req({ uri: 'https://x.test/a(b)' }), { ...filter, text: '(' }), true);
});
