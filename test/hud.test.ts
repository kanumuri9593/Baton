import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the daemon's state out of the real ~/.baton.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-hud-'));

const { renderHud, HUD_ASSETS } = await import('../src/hud/render.ts');
const { LaunchDaemon } = await import('../src/daemon/server.ts');

// --- renderHud --------------------------------------------------------------

test('renderHud injects the token and leaves no placeholder behind', () => {
  const html = renderHud('tok123');
  assert.ok(html.includes('tok123'), 'the token must reach the page');
  assert.ok(!html.includes('%%TOKEN%%'), 'the placeholder must be fully replaced');
});

test('renderHud references every allowlisted asset by name', () => {
  const html = renderHud('tok123');
  for (const name of HUD_ASSETS.keys()) {
    assert.ok(html.includes(name), `index.html must reference ${name}`);
  }
});

// --- the asset files themselves ---------------------------------------------

test('every allowlisted asset file exists on disk and is non-empty', () => {
  for (const [name, { path }] of HUD_ASSETS) {
    assert.ok(existsSync(path), `${name} must exist at ${path}`);
    assert.ok(statSync(path).size > 0, `${name} must not be empty`);
  }
});

// --- the daemon's asset route ------------------------------------------------

let daemon: InstanceType<typeof LaunchDaemon>;
let port: number;

before(async () => {
  daemon = new LaunchDaemon('test');
  const handshake = await daemon.listen(0);
  port = handshake.port;
});

after(async () => { await daemon.close(); });

/**
 * A raw request, bypassing whatever normalisation `fetch`/undici applies to a
 * `..` segment client-side, so the test actually exercises what the daemon
 * receives on the wire rather than what a well-behaved client would send.
 */
function rawGet(
  path: string,
): Promise<{ status: number; contentType?: string; cacheControl?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          contentType: res.headers['content-type'],
          cacheControl: res.headers['cache-control'],
          body,
        }),
      );
    });
    req.on('error', reject);
  });
}

test('GET /assets/hud.css serves the stylesheet', async () => {
  const res = await rawGet('/assets/hud.css');
  assert.equal(res.status, 200);
  assert.match(res.contentType!, /text\/css/);
  assert.ok(res.body.length > 0);
});

test('GET /assets/core.js serves the HUD script', async () => {
  const res = await rawGet('/assets/core.js');
  assert.equal(res.status, 200);
  assert.match(res.contentType!, /text\/javascript/);
  assert.ok(res.body.includes('window.BATON_TOKEN'));
});

test('GET /assets/<name not on the allowlist> is a 404', async () => {
  const res = await rawGet('/assets/nope.js');
  assert.equal(res.status, 404);
});

test('a raw traversal attempt never reaches the filesystem, and 404s', async () => {
  const res = await rawGet('/assets/../../package.json');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('"name": "baton-run"'), 'must not have served package.json');
});

test('GET / serves the token script with cache-control: no-store', async () => {
  const res = await rawGet('/');
  assert.equal(res.status, 200);
  assert.equal(res.cacheControl, 'no-store');
  assert.ok(res.body.includes('window.BATON_TOKEN='));
});

test('every asset the page links to actually resolves through the daemon', async () => {
  // A regression guard: an index.html that links "./hud.css" from a page served
  // at "/" would resolve to "/hud.css", not "/assets/hud.css" -- the browser
  // would 404 on every stylesheet and script even though the daemon's asset
  // route itself works fine. Follow each href/src the page actually emits.
  const page = await rawGet('/');
  const links = [...page.body.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= HUD_ASSETS.size, 'index.html must link every asset by its real /assets/ path');
  for (const link of links) {
    const res = await rawGet(link);
    assert.equal(res.status, 200, `${link} must resolve`);
  }
});
