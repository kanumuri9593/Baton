import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * The brand assets, read once from `assets/`.
 *
 * Read rather than duplicated, so the page, the README and the app icon can
 * never drift apart. A missing file degrades to no icon instead of a 500.
 */
function asset(name: string): string {
  try {
    return readFileSync(join(dirname(import.meta.dirname), '..', 'assets', name), 'utf8').trim();
  } catch {
    return '';
  }
}

const TILE = asset('baton.svg');
const MARK = asset('baton-mark.svg');
const FAVICON = TILE
  ? `data:image/svg+xml;base64,${Buffer.from(TILE).toString('base64')}`
  : '';

/**
 * The floating control surface, served by the daemon.
 *
 * Deliberately a single self-contained page with no build step and no external
 * requests: it has to work identically on macOS, Linux and Windows, and open
 * instantly in whatever browser is around. Open it in a small always-on-top
 * window (`baton hud --panel`) and it behaves like an IDE's debug toolbar.
 */
export function renderHud(token: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baton</title>
<link rel="icon" href="${FAVICON}">
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1f232c; --line: #2a2f3a;
    --text: #e6e9ef; --muted: #8b93a7; --accent: #5b8cff;
    --ok: #3fca7a; --warn: #f5b544; --err: #ff6b6b; --idle: #5a6272;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f6f7f9; --panel: #fff; --panel-2: #f0f2f5; --line: #dfe3ea;
      --text: #12151b; --muted: #66708a; --idle: #a8afbd;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; overflow-x: hidden;
  }
  /* Reserved for the host window's drag strip; see hud/mac/BatonHUD.swift. */
  body.panel { padding-top: var(--drag-strip, 0px); }
  header {
    display: flex; align-items: center; gap: 6px; padding: 7px 9px;
    background: var(--panel); border-bottom: 1px solid var(--line);
    position: sticky; top: 0; z-index: 5;
  }
  .brand { display: flex; align-items: center; gap: 7px; font-weight: 650; letter-spacing: -0.01em; }
  .brand svg { width: 22px; height: 22px; flex: none; color: var(--text); }
  .brand small { display: block; color: var(--muted); font-weight: 400; font-size: 10px; }
  button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 5px 9px; font: inherit; font-size: 12px;
    cursor: pointer; white-space: nowrap;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .35; cursor: not-allowed; }
  button.icon { font-size: 14px; padding: 4px 8px; line-height: 1; }
  button.danger:hover:not(:disabled) { border-color: var(--err); color: var(--err); }
  button.go { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 560; }
  button.go:hover:not(:disabled) { filter: brightness(1.1); }
  .spacer { margin-left: auto; }

  /* project tabs */
  nav {
    display: flex; gap: 5px; padding: 6px 9px; overflow-x: auto; align-items: center;
    background: var(--panel); border-bottom: 1px solid var(--line);
    position: sticky; top: 44px; z-index: 4; scrollbar-width: none;
  }
  nav::-webkit-scrollbar { display: none; }
  .chip {
    display: flex; align-items: center; gap: 5px; flex: none;
    background: transparent; border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 9px; font-size: 12px; color: var(--muted); cursor: pointer;
  }
  .chip:hover { color: var(--text); }
  .chip.on { background: var(--panel-2); color: var(--text); border-color: var(--accent); }
  .chip .badge {
    background: var(--ok); color: #06210f; border-radius: 999px;
    font-size: 10px; font-weight: 700; padding: 0 5px; min-width: 15px; text-align: center;
  }
  .chip .x { color: var(--muted); font-size: 13px; line-height: 1; }
  .chip .x:hover { color: var(--err); }

  /* launcher */
  .launcher { display: flex; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--line); }
  select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 5px 6px; font: inherit; font-size: 12px;
    min-width: 0; flex: 1 1 auto; text-overflow: ellipsis;
  }
  select#device { flex: 0 1 42%; }
  input[type=text] {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 5px 7px; font: inherit; font-size: 12px; flex: 1;
  }

  main { padding: 8px; display: grid; gap: 8px; }
  .group-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 2px 0 -2px 2px;
  }
  .row {
    background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
    padding: 8px 10px; display: grid; gap: 6px;
  }
  .row-top { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); flex: none; }
  .dot.running { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
  .dot.starting { background: var(--warn); animation: pulse 1.1s ease-in-out infinite; }
  .dot.failed { background: var(--err); }
  @keyframes pulse { 50% { opacity: .35; } }
  .name { font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--muted); font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; }
  .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px;
  }
  .empty { color: var(--muted); text-align: center; padding: 24px 12px; }
  .empty h2 { font-size: 14px; margin: 0 0 6px; color: var(--text); }
  .logs {
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--bg); border: 1px solid var(--line); border-radius: 7px;
    padding: 6px 8px; max-height: 190px; overflow: auto; white-space: pre-wrap;
    word-break: break-word; display: none;
  }
  .logs.open { display: block; }
  .logs .err { color: var(--err); }
  .toast {
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 12px;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
    padding: 7px 12px; font-size: 12px; opacity: 0; transition: opacity .18s;
    pointer-events: none; max-width: 92vw; z-index: 20; white-space: pre-wrap;
  }
  .toast.show { opacity: 1; }
  .toast.bad { border-color: var(--err); color: var(--err); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <div class="brand">${MARK}<div>Baton<small id="status">connecting…</small></div></div>
  <span class="spacer"></span>
  <button class="icon" id="reloadAll" title="Hot reload every running session (r)">⟳</button>
  <button class="icon" id="restartAll" title="Hot restart every running session (R)">⟲</button>
  <button class="icon danger" id="stopAll" title="Stop every running session">■</button>
</header>

<nav id="tabs"></nav>

<div class="launcher" id="addRow" hidden>
  <input type="text" id="addPath" placeholder="~/code/my-app — path to another project" spellcheck="false">
  <button class="go" id="addGo">Add</button>
  <button id="addCancel">Cancel</button>
</div>

<div class="launcher">
  <select id="picker"><option value="">Loading targets…</option></select>
  <select id="device" title="Device"><option value="">Auto</option></select>
  <button class="go" id="run">Run</button>
</div>

<main id="list"></main>
<div class="toast" id="toast"></div>

<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
const list = $('list'), picker = $('picker'), deviceSel = $('device');
const tabs = $('tabs'), statusEl = $('status'), toastEl = $('toast');

let socket, nextId = 1;
let sessions = new Map();
let projects = [];          // [{root, name, targets, error}]
let selectedRoot = null;    // null = show every project at once
let devices = [];           // connected, runnable now
let bootables = [];         // not running, but startable
let devicesLoaded = false;
const openLogs = new Set();
const pending = new Map();
const logBuffers = new Map();

const basename = (path) => String(path).split(/[\\\\/]/).filter(Boolean).pop() || path;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(text, bad) {
  toastEl.textContent = text;
  toastEl.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.className = 'toast'), bad ? 6000 : 3000);
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) return reject(new Error('daemon offline'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function connect() {
  socket = new WebSocket('ws://' + location.host + '?token=' + TOKEN);
  socket.onopen = () => { statusEl.textContent = 'connected'; loadProjects(); };
  socket.onclose = () => {
    statusEl.textContent = 'daemon offline — retrying';
    devicesLoaded = false;
    setTimeout(connect, 1500);
  };
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      return;
    }
    if (msg.event === 'hello') { sessions = new Map(msg.sessions.map((s) => [s.id, s])); render(); }
    if (msg.event === 'session') { sessions.set(msg.snapshot.id, msg.snapshot); render(); }
    if (msg.event === 'devices') loadDevices(true);
    if (msg.event === 'log') appendLog(msg);
  };
}

// --- projects -------------------------------------------------------------

async function loadProjects() {
  try {
    const result = await call('projects');
    projects = result.projects ?? [];
    if (selectedRoot && !projects.some((p) => p.root === selectedRoot)) selectedRoot = null;
    if (selectedRoot === null && projects.length === 1) selectedRoot = projects[0].root;
    renderTabs();
    renderPicker();
    render();
    loadDevices();
  } catch (err) { toast(err.message, true); }
}

function renderTabs() {
  tabs.innerHTML = '';

  if (projects.length > 1) {
    tabs.appendChild(chip('All', selectedRoot === null, countFor(null), () => select(null)));
  }
  for (const project of projects) {
    const on = selectedRoot === project.root;
    const el = chip(project.name, on, countFor(project.root), () => select(project.root));
    el.title = project.root + (project.error ? '\\n⚠ ' + project.error : '');
    if (project.error) el.style.borderColor = 'var(--warn)';

    // Removing is only offered for the project you are looking at, so a
    // mis-click on a crowded strip cannot quietly drop a different one.
    if (on && projects.length > 1) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Remove ' + project.name + ' from this list (nothing on disk changes)';
      x.onclick = async (e) => {
        e.stopPropagation();
        await call('removeProject', { root: project.root }).catch(() => {});
        selectedRoot = null;
        loadProjects();
      };
      el.appendChild(x);
    }
    tabs.appendChild(el);
  }

  const add = chip('+', false, 0, () => {
    const row = $('addRow');
    row.hidden = !row.hidden;
    if (!row.hidden) $('addPath').focus();
  });
  add.title = 'Add another project';
  tabs.appendChild(add);
}

function chip(label, on, count, onClick) {
  const el = document.createElement('div');
  el.className = 'chip' + (on ? ' on' : '');
  el.onclick = onClick;
  const text = document.createElement('span');
  text.textContent = label;
  el.appendChild(text);
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(count);
    el.appendChild(badge);
  }
  return el;
}

const countFor = (root) =>
  [...sessions.values()].filter(
    (s) => (root === null || s.root === root) && (s.status === 'running' || s.status === 'starting'),
  ).length;

function select(root) {
  selectedRoot = root;
  renderTabs();
  renderPicker();
  render();
}

$('addGo').onclick = async () => {
  const path = $('addPath').value.trim();
  if (!path) return;
  try {
    const project = await call('addProject', { path });
    $('addPath').value = '';
    $('addRow').hidden = true;
    selectedRoot = project.root;
    await loadProjects();
    toast(project.name + ' — ' + project.targets.length + ' targets');
  } catch (err) { toast(err.message, true); }
};
$('addCancel').onclick = () => { $('addRow').hidden = true; };
$('addPath').onkeydown = (e) => { if (e.key === 'Enter') $('addGo').click(); };

// --- targets and devices --------------------------------------------------

/** Projects currently in scope: one, or all of them. */
const visibleProjects = () =>
  selectedRoot === null ? projects : projects.filter((p) => p.root === selectedRoot);

function renderPicker() {
  const previous = picker.value;
  picker.innerHTML = '';
  const scope = visibleProjects();
  const grouped = scope.length > 1;
  let total = 0;

  for (const project of scope) {
    const parent = grouped
      ? Object.assign(document.createElement('optgroup'), { label: project.name })
      : picker;
    for (const target of project.targets) {
      const option = document.createElement('option');
      const blocked = target.issues && target.issues.length;
      option.value = project.root + '\\u0000' + target.name;
      option.textContent = (blocked ? '⚠ ' : '') + target.name + '  ·  ' + target.kind;
      option.title = blocked
        ? target.issues.map((i) => 'missing ' + i.path + ' — ' + i.hint).join('\\n')
        : project.root;
      parent.appendChild(option);
      total++;
    }
    if (grouped && project.targets.length) picker.appendChild(parent);
  }

  if (!total) {
    picker.innerHTML = '<option value="">No runnable targets</option>';
  } else if (previous) {
    picker.value = previous; // keep the selection across re-renders
  }
  statusEl.textContent = selectedRoot ? basename(selectedRoot) : projects.length + ' projects';
}

/**
 * Fill the device menu: what can be run on now, and what can be started.
 *
 * Discovery spawns a \`flutter daemon\`, so it is done once in the background and
 * never blocks the first paint.
 */
async function loadDevices(force) {
  if (devicesLoaded && !force) return;
  devicesLoaded = true;
  try {
    const cwd = selectedRoot;
    const [connected, startable] = await Promise.all([
      call('devices', { cwd }), call('bootables', { cwd }),
    ]);
    devices = connected ?? [];
    bootables = startable ?? [];
    renderDevices();
  } catch (err) {
    devicesLoaded = false;
    statusEl.title = 'device discovery failed: ' + err.message;
  }
}

function renderDevices() {
  const previous = deviceSel.value;
  deviceSel.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Auto · match target';
  auto.title = 'Pick a device from the target name, the way an IDE does';
  deviceSel.appendChild(auto);

  if (devices.length) {
    const group = document.createElement('optgroup');
    group.label = 'Connected';
    for (const device of devices) {
      const option = document.createElement('option');
      option.value = 'use:' + device.id;
      option.textContent = device.name;
      option.title = device.id + ' · ' + device.platform;
      group.appendChild(option);
    }
    deviceSel.appendChild(group);
  }

  const startable = bootables.filter((b) => !b.running);
  if (startable.length) {
    const group = document.createElement('optgroup');
    group.label = 'Start new';
    for (const device of startable) {
      const option = document.createElement('option');
      option.value = 'boot:' + device.id;
      option.textContent = device.name + (device.runtime ? '  ·  ' + device.runtime : '');
      option.title = 'Boot this ' + device.platformType + ' device, then run on it';
      group.appendChild(option);
    }
    deviceSel.appendChild(group);
  }

  const refresh = document.createElement('option');
  refresh.value = 'refresh';
  refresh.textContent = '↻ Refresh devices';
  deviceSel.appendChild(refresh);

  if (previous) deviceSel.value = previous;
  if (!deviceSel.value) deviceSel.value = '';
}

deviceSel.onchange = () => {
  if (deviceSel.value !== 'refresh') return;
  deviceSel.value = '';
  toast('looking for devices…');
  loadDevices(true);
};

// --- running --------------------------------------------------------------

$('run').onclick = async () => {
  const value = picker.value;
  if (!value) return;
  const [root, target] = value.split('\\u0000');
  const choice = deviceSel.value;
  const button = $('run');
  button.disabled = true;

  try {
    let deviceId;
    if (choice.startsWith('use:')) {
      deviceId = choice.slice(4);
    } else if (choice.startsWith('boot:')) {
      // Boot first and run on exactly that device -- otherwise the launch races
      // discovery and lands on whichever simulator happens to answer first.
      const id = choice.slice(5);
      const name = (bootables.find((b) => b.id === id) || {}).name || id;
      toast('booting ' + name + '…');
      const device = await call('boot', { id, cwd: root });
      deviceId = device.id;
      deviceSel.value = 'use:' + device.id;
      loadDevices(true);
    }
    await call('run', { target, cwd: root, deviceId });
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
};

$('reloadAll').onclick = () => act('reload', scopedAll());
$('restartAll').onclick = () => act('restart', scopedAll());
$('stopAll').onclick = () => act('stop', scopedAll());

/**
 * "Every session" means every session in view.
 *
 * With three projects open, reload-all while looking at one of them must not
 * restart the other two.
 */
function scopedAll() {
  if (selectedRoot === null) return { all: true };
  const ids = [...sessions.values()]
    .filter((s) => s.root === selectedRoot && s.status === 'running')
    .map((s) => s.id);
  return { ids };
}

async function act(method, params) {
  try {
    if (params.ids && params.ids.length === 0) return toast('nothing running here');
    const result = await call(method, params);
    if (Array.isArray(result)) {
      const failed = result.filter((r) => r.code && r.code !== 0);
      if (failed.length) {
        const first = failed[0];
        return toast([first.message, ...(first.errors ?? []).slice(0, 3)].filter(Boolean).join('\\n'), true);
      }
      const first = result[0];
      if (first && first.message) toast(first.message);
    }
  } catch (err) { toast(err.message, true); }
}

// --- session list ---------------------------------------------------------

function render() {
  renderTabs();
  const all = [...sessions.values()]
    .filter((s) => selectedRoot === null || s.root === selectedRoot)
    .sort((a, b) => a.startedAt - b.startedAt);

  if (!all.length) {
    const where = selectedRoot ? ' in ' + basename(selectedRoot) : '';
    list.innerHTML = '<div class="empty"><h2>Nothing running' + where + '</h2>' +
      'Pick a target above and press Run — or start one from a terminal with ' +
      '<code>baton run &lt;name&gt;</code>.</div>';
    return;
  }

  list.innerHTML = '';
  // Group by project only when more than one is in view; a single project
  // would just get a redundant heading.
  const groups = new Map();
  for (const s of all) {
    const key = s.root ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const labelled = selectedRoot === null && groups.size > 1;
  for (const [root, group] of groups) {
    if (labelled) {
      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = basename(root) || 'unknown project';
      title.title = root;
      list.appendChild(title);
    }
    for (const s of group) list.appendChild(renderRow(s));
  }
}

function renderRow(s) {
  const can = (c) => s.capabilities.includes(c);
  const live = s.status === 'running';

  const row = document.createElement('div');
  row.className = 'row';

  const top = document.createElement('div');
  top.className = 'row-top';
  top.innerHTML =
    '<span class="dot ' + s.status + '"></span>' +
    '<span class="name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
    '<span class="tag">' + esc(s.kind) + '</span><span class="spacer"></span>';

  const button = (label, title, enabled, onClick, cls) => {
    const b = document.createElement('button');
    b.className = 'icon ' + (cls || '');
    b.textContent = label;
    b.title = title;
    b.disabled = !enabled;
    b.onclick = onClick;
    return b;
  };

  top.appendChild(button('⟳', can('hotReload') ? 'Hot reload (keeps state)'
    : 'Hot reload not available for ' + s.kind, live && can('hotReload'),
    () => act('reload', { session: s.id })));
  top.appendChild(button('⟲', can('hotRestart') || can('restartProcess')
    ? 'Hot restart' : 'Restart not available', live && (can('hotRestart') || can('restartProcess')),
    () => act('restart', { session: s.id })));
  top.appendChild(button('■', 'Stop', live || s.status === 'starting',
    () => act('stop', { session: s.id }), 'danger'));
  top.appendChild(button('▤', 'Toggle logs', true, () => toggleLogs(s.id)));

  if (s.url) top.appendChild(button('↗', 'Open ' + s.url, true, () => window.open(s.url, '_blank')));
  if (s.devToolsUri) {
    top.appendChild(button('⚙', 'Open DevTools', true, () => window.open(s.devToolsUri, '_blank')));
  }
  row.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [s.status];
  if (s.progress) bits.push(s.progress);
  if (s.target) bits.push(deviceName(s.target));
  if (s.exitCode !== undefined && s.exitCode !== null) bits.push('exit ' + s.exitCode);
  meta.textContent = bits.join('  ·  ');
  row.appendChild(meta);

  const logs = document.createElement('div');
  logs.className = 'logs' + (openLogs.has(s.id) ? ' open' : '');
  logs.dataset.logs = s.id;
  for (const line of logBuffers.get(s.id) ?? []) {
    const el = document.createElement('div');
    if (line.error) el.className = 'err';
    el.textContent = line.text;
    logs.appendChild(el);
  }
  row.appendChild(logs);
  if (openLogs.has(s.id)) queueMicrotask(() => (logs.scrollTop = logs.scrollHeight));

  return row;
}

/** Show "iPhone 17 Pro" rather than a bare UDID once discovery has run. */
function deviceName(id) {
  const device = devices.find((d) => d.id === id);
  return device ? device.name : id;
}

function appendLog({ sessionId, text, error }) {
  let buffer = logBuffers.get(sessionId);
  if (!buffer) logBuffers.set(sessionId, (buffer = []));
  buffer.push({ text, error });
  if (buffer.length > 400) buffer.splice(0, buffer.length - 400);
  if (!openLogs.has(sessionId)) return;
  const pane = document.querySelector('[data-logs="' + sessionId + '"]');
  if (!pane) return;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  const line = document.createElement('div');
  if (error) line.className = 'err';
  line.textContent = text;
  pane.appendChild(line);
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

async function toggleLogs(id) {
  if (openLogs.has(id)) { openLogs.delete(id); render(); return; }
  openLogs.add(id);
  try {
    const lines = await call('logs', { session: id, tail: 300 });
    logBuffers.set(id, lines.map((l) => ({ text: l.text, error: l.error })));
  } catch { /* keep whatever was streamed */ }
  render();
}

// Keyboard shortcuts mirroring the flutter run terminal: r reload, R restart.
addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || e.metaKey || e.ctrlKey) return;
  if (e.key === 'r') act('reload', scopedAll());
  if (e.key === 'R') act('restart', scopedAll());
});

if (new URLSearchParams(location.search).get('chrome') === 'panel') {
  document.body.classList.add('panel');
}

connect();
</script>
</body>
</html>`;
}
