import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
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
  assert.ok(!html.includes('%%MARK%%') && !html.includes('%%CHIP_MARK%%') && !html.includes('%%FAVICON%%'),
    'brand placeholders must be fully replaced');
  assert.match(html, /id="chip-sweep"/);
});

test('the HUD launcher includes a checkout picker next to device', () => {
  const html = renderHud('tok123');
  assert.match(html, /id="checkout"/);
  const core = readFileSync(HUD_ASSETS.get('core.js')!.path, 'utf8');
  assert.match(core, /'checkouts'/);
  assert.match(core, /forgotten/);
});

// --- the asset files themselves ---------------------------------------------

test('every allowlisted asset file exists on disk and is non-empty', () => {
  for (const [name, { path }] of HUD_ASSETS) {
    assert.ok(existsSync(path), `${name} must exist at ${path}`);
    assert.ok(statSync(path).size > 0, `${name} must not be empty`);
  }
});

/**
 * The contract between core.js and its add-ons.
 *
 * These files only meet in a browser, which no test here runs, so the one thing
 * worth pinning is that they still agree: an add-on that reaches for a hook
 * core.js stopped offering fails silently in the page, and nothing else would
 * catch it.
 */
test('the add-ons hook into core.js rather than being wired into it', () => {
  const read = (name: string) => readFileSync(HUD_ASSETS.get(name)!.path, 'utf8');
  const core = read('core.js');
  const editor = read('editor.js');

  for (const name of ['network.js', 'editor.js', 'inspector.js']) {
    assert.match(read(name), /window\.baton/, `${name} must go through the hook registry`);
  }
  // core.js knows nothing about the launch.json feature: every one of those
  // calls belongs to editor.js, and the day one migrates back into core.js is
  // the day this file starts growing every feature again.
  for (const method of ['browseDirs', 'readLaunchConfig', 'writeLaunchConfig', 'editLaunchConfig',
    'generateLaunchConfig', 'validateLaunchConfig']) {
    assert.ok(!core.includes(`'${method}'`), `core.js must not call ${method} itself`);
    assert.ok(editor.includes(`'${method}'`), `editor.js must be the one calling ${method}`);
  }

  // Everything editor.js destructures out of window.baton must be there.
  const provided = core.slice(core.indexOf('window.baton = {'));
  const taken = /const \{([^}]+)\} = window\.baton;/.exec(editor)![1];
  for (const name of taken.split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.match(provided, new RegExp('\\b' + name + '\\b'), `core.js must still expose ${name}`);
  }

  // And the hooks editor.js and inspector.js register must still be dispatched.
  for (const hook of ['openProject', 'chip', 'sessionFocus', 'density']) {
    assert.ok(core.includes(hook), `core.js must still call the "${hook}" hook`);
  }

  const inspector = read('inspector.js');
  assert.ok(inspector.includes('extend('), 'inspector.js must register as an add-on');
  assert.match(inspector, /matchLog/, 'inspector.js must use the shared log filter');
  assert.match(inspector, /matchNetwork/, 'inspector.js must use the shared network filter');
  assert.match(inspector, /wireGutter/, 'inspector.js must own the column splitters');
  assert.match(core, /baton\.hud\.splits/);
  assert.match(core, /function wireGutter/);
});

test('session actions are named SVG icons, not unicode glyphs', () => {
  const core = readFileSync(HUD_ASSETS.get('core.js')!.path, 'utf8');
  const icons = readFileSync(HUD_ASSETS.get('icons.js')!.path, 'utf8');
  assert.match(core, /iconButton\(/);
  for (const glyph of ['⟳', '⟲', '▤', '⇅']) {
    assert.ok(!core.includes(`'${glyph}'`), `core.js must not use ${glyph} as a button label`);
  }
  for (const name of ['run', 'reload', 'restart', 'stop', 'logs', 'network', 'expand', 'minimize']) {
    assert.match(icons, new RegExp('\\b' + name + '\\s*:'), `icons.js must define ${name}`);
  }
});

test('the page has a chip, a peek strip, and an inspector pane', () => {
  const html = renderHud('tok123');
  assert.match(html, /id="chip"/);
  assert.match(html, /id="chipMark"/);
  assert.match(html, /id="peek"/);
  assert.match(html, /id="inspector"/);
  assert.match(html, /id="splitOuter"/);
  assert.match(html, /data-density/);
  assert.ok(!html.includes('id="chipDot"'), 'the chip shows the Baton mark, not a status LED');
});

test('the compact HUD is a floating logo that clicks to open and drags to move', () => {
  const html = renderHud('tok123');
  const core = readFileSync(HUD_ASSETS.get('core.js')!.path, 'utf8');
  const css = readFileSync(HUD_ASSETS.get('hud.css')!.path, 'utf8');
  const swift = readFileSync(join(import.meta.dirname, '../hud/mac/main.swift'), 'utf8');
  assert.match(html, /id="chipFace" role="button" tabindex="0"/);
  assert.match(core, /face\.onclick = toggle/);
  assert.ok(!core.includes("chip.addEventListener('mouseenter'"), 'opening must not depend on hover timing');
  assert.match(css, /body\[data-density="chip"\] #chipExpand \{ display: none; \}/,
    'the old side button must not be clipped inside the compact chip');
  assert.match(core, /chip: \{ width: 58, height: 58 \}/);
  assert.match(core, /live\.length \? String\(live\.length\) : ''/,
    'an idle floating logo must not carry a meaningless zero');
  assert.match(swift, /class CompactChipSurface/);
  assert.match(swift, /override func mouseDragged/);
  assert.match(swift, /if hypot\(dx, dy\) >= 3 \{ dragged = true \}/);
  assert.match(swift, /if !dragged/);
});

test('the macOS panel pins resize to the trailing edge', () => {
  const source = readFileSync(join(import.meta.dirname, '../hud/mac/main.swift'), 'utf8');
  assert.match(source, /batonHud/);
  assert.match(source, /pinTrailing/);
  assert.match(source, /WKScriptMessageHandler/);
  assert.match(source, /miniaturizable/);
  assert.match(source, /applicationShouldHandleReopen/);
  assert.match(source, /setActivationPolicy\(\.regular\)/);
  assert.match(source, /isTemplate = false/);
  assert.match(source, /dockIcon/);
});

test('the macOS menu-bar item separates adaptive chrome, count, and run status', () => {
  const source = readFileSync(join(import.meta.dirname, '../hud/mac/main.swift'), 'utf8');
  assert.match(source, /menuBarIcon/);
  assert.match(source, /NSColor\.labelColor\.setFill\(\)/,
    'the Baton mark must follow the current light or dark menu-bar appearance');
  assert.match(source, /foregroundColor: NSColor\.labelColor/,
    'the session count must remain neutral rather than inheriting status color');
  for (const state of ['running', 'starting', 'failed', 'offline']) {
    assert.match(source, new RegExp(`case \\.${state}`), `the badge must represent ${state}`);
  }
  assert.match(source, /string: count > 0 \? "\\\(count\)" : ""/,
    'zero should stay visually quiet while active sessions show their count');
});

test('quitting the macOS app confirms and shuts down every run', () => {
  const source = readFileSync(join(import.meta.dirname, '../hud/mac/main.swift'), 'utf8');
  assert.match(source, /applicationShouldTerminate\(/, 'Cmd-Q and app-menu Quit must use the guarded quit path');
  assert.match(source, /Quit Baton and stop all runs\?/);
  assert.match(source, /rpc\("shutdown"\)/, 'confirmed Quit must shut down the daemon, which owns all sessions');
  assert.match(source, /reply\(toApplicationShouldTerminate: true\)/, 'Quit must wait for daemon acknowledgement');
  assert.match(source, /Quit Baton…/, 'the status menu must describe the full-app quit semantics');
});

test('reopening the macOS app starts the daemon and never shows a blank panel', () => {
  const swift = readFileSync(join(import.meta.dirname, '../hud/mac/main.swift'), 'utf8');
  const builder = readFileSync(join(import.meta.dirname, '../src/hud/panel.ts'), 'utf8');
  assert.match(swift, /Starting Baton…/);
  assert.match(swift, /startDaemonIfNeeded/);
  assert.match(swift, /launcher.*json/i, 'the app must use the launcher bundled at build time');
  assert.match(swift, /\/health/, 'a stale handshake must be verified before WebKit loads it');
  assert.match(swift, /retryDaemon/, 'a failed start must offer a recovery action');
  assert.match(builder, /process\.execPath/);
  assert.match(builder, /launcher\.json/);
});

test('the generated HUD app is a regular Mac app with a Dock icon', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/hud/panel.ts'), 'utf8');
  assert.ok(!source.includes('LSUIElement'), 'LSUIElement would hide the Dock tile');
  assert.match(source, /CFBundleIconFile/);
  assert.match(source, /baton\.icns/, 'rebuild must copy the generated icns into the app');
  assert.match(
    source,
    /\.update\(readFileSync\(icns\)\)/,
    'icns contents must participate in the rebuild stamp so a new icon is picked up',
  );
});

test('the Dock tile is the full Baton mark at retina resolution', () => {
  const source = readFileSync(join(import.meta.dirname, '../hud/mac/main.swift'), 'utf8');
  assert.match(source, /url\(forResource: "baton", withExtension: "icns"\)/);
  assert.match(source, /NSBitmapImageRep/);
  assert.match(source, /NSGradient/);
  assert.match(source, /#7b7cff|#7B7CFF|123 \/ 255.*124 \/ 255.*1/, 'tile gradient start from baton.svg');
  assert.match(source, /destinationOut|CGBlendMode/, 'lanes are cut where the baton sweeps, as in the SVG mask');
  assert.ok(
    !/applicationIconImage = icon/.test(source),
    'assigning the icns to applicationIconImage makes a running Dock tile use a low-res bitmap; the bundle icon is enough',
  );
});

test('the HUD posts density with resize so native chrome can follow', () => {
  const core = readFileSync(HUD_ASSETS.get('core.js')!.path, 'utf8');
  assert.match(core, /density: name/);
  assert.match(core, /rssBytes/);
  assert.match(core, /heaviestId/);
  assert.match(core, /chipMark/);
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
