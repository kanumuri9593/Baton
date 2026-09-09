const TOKEN = window.BATON_TOKEN;
const $ = (id) => document.getElementById(id);
const list = $('list'), picker = $('picker'), deviceSel = $('device'), checkoutSel = $('checkout');
const tabs = $('tabs'), statusEl = $('status'), toastEl = $('toast');
const historyBtn = $('historyBtn'), historyPanel = $('historyPanel');
const historyList = $('historyList'), historyLogs = $('historyLogs');

let socket, nextId = 1;
let sessions = new Map();
let activeSessionId = null; // session the peek strip and inspector follow
let projects = [];          // [{root, name, targets, error}]
const PROJECT_KEY = 'baton.lastProject';
let selectedRoot = restoreSelectedRoot(); // null = show every project at once
let devices = [];           // connected, runnable now
let bootables = [];         // not running, but startable
let devicesLoaded = false;
let checkouts = [];
let checkoutsLoaded = false;
let checkoutRoot = null;
let checkoutRequest = 0;
let deviceRoot = null;
let deviceRequest = 0;
let projectRequest = 0;
let projectFingerprint = null;
const openLogs = new Set();
const pending = new Map();
const logBuffers = new Map();

function storedPreferences() {
  try { return JSON.parse(localStorage.getItem('baton.preferences.v1') || '{}'); }
  catch { return {}; }
}

function restoreSelectedRoot() {
  if (storedPreferences().restoreProject === false) return null;
  try { return localStorage.getItem(PROJECT_KEY) || null; }
  catch { return null; }
}

function rememberSelectedRoot(root) {
  try {
    if (root) localStorage.setItem(PROJECT_KEY, root);
    else localStorage.removeItem(PROJECT_KEY);
  } catch { /* private mode */ }
}

const basename = (path) => String(path).split(/[\\/]/).filter(Boolean).pop() || path;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function iconEl(name) {
  const html = (typeof BatonIcons !== 'undefined' && BatonIcons[name]) || '';
  const span = document.createElement('span');
  span.className = 'ico';
  // Icons are a closed set of SVG strings we own, not user content.
  if (html) span.innerHTML = html;
  else span.textContent = name;
  return span;
}

function iconButton(name, title, enabled, onClick, cls) {
  const b = document.createElement('button');
  b.className = 'icon ' + (cls || '');
  b.title = title;
  b.disabled = !enabled;
  b.appendChild(iconEl(name));
  if (onClick) b.onclick = onClick;
  return b;
}

function fillIcon(node, name) {
  if (!node) return;
  node.textContent = '';
  node.appendChild(iconEl(name));
}

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
  socket.onopen = () => { statusEl.textContent = 'connected'; projectFingerprint = null; loadProjects(); };
  socket.onclose = () => {
    statusEl.textContent = 'daemon offline — retrying';
    devicesLoaded = false;
    checkoutsLoaded = false;
    for (const request of pending.values()) request.reject(new Error('daemon disconnected'));
    pending.clear();
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
    if (msg.event === 'forgotten') { sessions.delete(msg.sessionId); render(); }
    if (msg.event === 'devices') loadDevices(true);
    if (msg.event === 'log') appendLog(msg);
    hook('event', msg);
  };
}

// --- add-ons ---------------------------------------------------------------

/**
 * The HUD's own extension point.
 *
 * The network inspector and the launch.json editor are separate scripts so each
 * owns its file rather than growing this one. They hook in here: `row` decorates
 * a session row as it is built, `chip` decorates a project tab, `event` sees
 * every pushed message, and `openProject` (if any addon offers one) takes over
 * the "+" tab with something better than a bare path box.
 */
const SPLIT_KEY = 'baton.hud.splits';
const SPLIT_CHIP = 52;
const SPLIT_GUTTER = 8;
const SPLIT_MIN_MAIN = 240;
const SPLIT_MIN_INSPECTOR = 280;
const SPLIT_MIN_PANE = 180;
const SPLIT_INSPECTOR_RATIO = 1.35 / (1 + 1.35);

function parseSplits(raw) {
  if (typeof raw !== 'string' || !raw) return { inspector: null, detail: null };
  try {
    const data = JSON.parse(raw);
    const inspector = Number.isFinite(data.inspector) ? data.inspector : null;
    const detail = Number.isFinite(data.detail) ? data.detail : null;
    return { inspector, detail };
  } catch {
    return { inspector: null, detail: null };
  }
}

function loadSplits() {
  try { return parseSplits(localStorage.getItem(SPLIT_KEY)); }
  catch { return { inspector: null, detail: null }; }
}

function saveSplits(splits) {
  try { localStorage.setItem(SPLIT_KEY, JSON.stringify(splits)); }
  catch { /* private mode */ }
}

function clampInspectorWidth(viewport, stored) {
  const leftover = viewport - SPLIT_CHIP - SPLIT_GUTTER;
  if (leftover <= 0) return 0;
  const floor = Math.min(SPLIT_MIN_INSPECTOR, leftover);
  const ceiling = Math.max(floor, leftover - SPLIT_MIN_MAIN);
  const fallback = leftover * SPLIT_INSPECTOR_RATIO;
  const value = stored == null ? fallback : stored;
  return Math.round(Math.min(ceiling, Math.max(floor, value)));
}

function clampDetailWidth(inner, stored) {
  const leftover = inner - SPLIT_GUTTER;
  if (leftover <= 0) return 0;
  const floor = Math.min(SPLIT_MIN_PANE, leftover);
  const ceiling = Math.max(floor, leftover - SPLIT_MIN_PANE);
  const fallback = leftover / 2;
  const value = stored == null ? fallback : stored;
  return Math.round(Math.min(ceiling, Math.max(floor, value)));
}

/** Drag a vertical gutter. Positive delta = grow the pane on the right. */
function wireGutter(el, onDelta, onEnd) {
  const start = (clientX, pointerId) => {
    let last = clientX;
    const move = (x) => { onDelta(last - x); last = x; };
    const done = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (onEnd) onEnd();
    };
    const onPointerMove = (e) => move(e.clientX);
    const onPointerUp = () => done();
    const onMouseMove = (e) => move(e.clientX);
    const onMouseUp = () => done();
    if (pointerId !== undefined && el.setPointerCapture) {
      try { el.setPointerCapture(pointerId); } catch { /* not a pointer event */ }
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };
  el.addEventListener(window.PointerEvent ? 'pointerdown' : 'mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    start(event.clientX, event.pointerId);
  });
}

const addons = [];
window.baton = {
  call, toast, esc, humanSize, iconEl, iconButton,
  extend(addon) { addons.push(addon); render(); },
  loadSplits, saveSplits, clampInspectorWidth, clampDetailWidth, wireGutter,

  // --- project-level state, for addons that work on projects rather than
  // sessions. Read-only accessors rather than the arrays themselves, so an
  // addon cannot mutate what this file re-renders from.
  projects: () => projects.slice(),
  activeRoot: () => selectedRoot,
  sessions: () => [...sessions.values()],
  logBuffer: (id) => (logBuffers.get(id) ?? []).slice(),
  hydrateLogs,
  activeSession: () => activeSessionId,
  setActiveSession,
  setDensity,
  /** Show this project and reload the list -- what adding one does. */
  async focusProject(root) {
    selectedRoot = root;
    await loadProjects();
  },
  refresh: () => loadProjects(),
};

/** Let every addon see one hook, without one throwing addon breaking the render. */
function hook(name, ...args) {
  for (const addon of addons) {
    try { addon[name] && addon[name](...args); } catch (err) { console.error(err); }
  }
}

// --- projects -------------------------------------------------------------

async function loadProjects() {
  const request = ++projectRequest;
  try {
    const result = await call('projects');
    if (request !== projectRequest) return;
    const fingerprint = JSON.stringify((result.projects ?? []).map(({ inspection, ...project }) => ({
      ...project, inspection: inspection && { ...inspection, checkedAt: undefined },
    })));
    if (fingerprint === projectFingerprint) return;
    projectFingerprint = fingerprint;
    projects = result.projects ?? [];
    if (selectedRoot && !projects.some((p) => p.root === selectedRoot)) selectedRoot = null;
    if (selectedRoot === null && projects.length === 1) selectedRoot = projects[0].root;
    renderTabs();
    renderPicker();
    render();
    loadDevices();
    loadCheckouts();
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
    el.title = project.root + (project.error ? '\n⚠ ' + project.error : '');
    if (project.error) el.style.borderColor = 'var(--warn)';

    // Removing is only offered for the project you are looking at, so a
    // mis-click on a crowded strip cannot quietly drop a different one.
    if (on && projects.length > 1) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
        x.title = 'Remove ' + project.name + ' from this list. Baton-owned branch copies are deleted; agent worktrees stay.';
      x.onclick = async (e) => {
        e.stopPropagation();
        await call('removeProject', { root: project.root }).catch(() => {});
        selectedRoot = null;
        rememberSelectedRoot(null);
        loadProjects();
      };
      el.appendChild(x);
    }
    hook('chip', project, el);
    tabs.appendChild(el);
  }

  const add = chip('+', false, 0, () => {
    // A browser cannot open a native folder picker, so editor.js offers one
    // built out of the daemon's own directory listing. The inline path box
    // stays as the fallback for when that script is not loaded.
    const opener = addons.find((a) => a.openProject);
    if (opener) return opener.openProject();
    const row = $('addRow');
    row.hidden = !row.hidden;
    if (!row.hidden) $('addPath').focus();
  });
  add.title = 'Open another project';
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
  rememberSelectedRoot(root);
  renderTabs();
  renderPicker();
  render();
  loadDevices();
  loadCheckouts();
  loadProjects();
  if (!historyPanel.hidden) loadHistory();
}

// --- history: past runs, persisted on disk ---------------------------------

historyBtn.onclick = () => {
  const opening = historyPanel.hidden;
  historyPanel.hidden = !opening;
  if (opening) loadHistory();
};

async function loadHistory() {
  historyList.innerHTML = '<div class="empty">Loading…</div>';
  historyLogs.innerHTML = '';
  historyLogs.classList.remove('open');
  try {
    const runs = await call('logHistory', { root: selectedRoot ?? undefined });
    renderHistoryList(runs);
  } catch (err) {
    historyList.innerHTML = '';
    toast(err.message, true);
  }
}

function renderHistoryList(runs) {
  historyList.innerHTML = '';
  if (!runs.length) {
    historyList.innerHTML = '<div class="empty">No runs recorded yet.</div>';
    return;
  }
  for (const run of runs) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const status = run.live ? 'live' : run.exitCode == null ? '?' : 'exit ' + run.exitCode;
    const dotClass = run.live ? 'running' : run.exitCode ? 'failed' : 'stopped';
    row.innerHTML =
      '<span class="dot ' + dotClass + '"></span>' +
      '<span class="name" title="' + esc(run.name) + '">' + esc(run.name) + '</span>' +
      '<span class="tag">' + esc(status) + '</span>' +
      '<span class="meta">' + relativeTime(run.startedAt) + '  ·  ' + humanSize(run.sizeBytes) + '</span>';
    row.onclick = () => openHistoryRun(run);
    historyList.appendChild(row);
  }
}

async function openHistoryRun(run) {
  historyLogs.classList.add('open');
  historyLogs.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const lines = await call('logRead', { run: run.runId, tail: 300 });
    historyLogs.innerHTML = '';
    for (const line of lines) {
      const el = document.createElement('div');
      if (line.error) el.className = 'err';
      el.textContent = line.text;
      historyLogs.appendChild(el);
    }
    historyLogs.scrollTop = historyLogs.scrollHeight;
  } catch (err) {
    historyLogs.innerHTML = '';
    toast(err.message, true);
  }
}

/** "2h ago" -- coarse on purpose, exact timestamps aren't the point of a run list. */
function relativeTime(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.round(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

/** "1.2 MB" -- binary units, matching the CLI's `baton history`. */
function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, unit = units[0];
  for (const u of units) {
    unit = u;
    if (value < 1024) break;
    value /= 1024;
  }
  return value.toFixed(1) + ' ' + unit;
}

$('addGo').onclick = async () => {
  const path = $('addPath').value.trim();
  if (!path) return;
  try {
    const project = await call('addProject', { path });
    $('addPath').value = '';
    $('addRow').hidden = true;
    // A project with nothing runnable is not remembered by the daemon, so
    // saying "0 targets" and showing no tab would look like the add failed.
    if (project.needsConfig) {
      toast(project.name + ' has no launch config yet — run `baton init` in it', true);
      return;
    }
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
      option.value = project.root + '\u0000' + target.name;
      option.textContent = (blocked ? '⚠ ' : '') + target.name + '  ·  ' + target.kind;
      option.title = blocked
        ? target.issues.map((i) => 'missing ' + i.path + ' — ' + i.hint).join('\n')
        : project.root;
      parent.appendChild(option);
      total++;
    }
    if (grouped && project.targets.length) picker.appendChild(parent);
  }

  if (!total) {
    picker.innerHTML = '<option value="">No runnable targets</option>';
  } else if ([...picker.options].some((option) => option.value === previous)) {
    picker.value = previous;
  }
  renderLaunchGuide();
  statusEl.textContent = selectedRoot ? basename(selectedRoot) : projects.length + ' projects';
}

/**
 * Fill the device menu: what can be run on now, and what can be started.
 *
 * Discovery spawns a `flutter daemon`, so it is done once in the background and
 * never blocks the first paint.
 */
async function loadDevices(force) {
  const cwd = launchRoot();
  if (devicesLoaded && deviceRoot === cwd && !force) return;
  const request = ++deviceRequest;
  if (deviceRoot !== cwd) { devices = []; bootables = []; renderDevices(); }
  deviceRoot = cwd;
  devicesLoaded = true;
  try {
    const [connected, startable] = await Promise.all([
      call('devices', { cwd }), call('bootables', { cwd }),
    ]);
    if (request !== deviceRequest) return;
    devices = connected ?? [];
    bootables = startable ?? [];
    renderDevices();
  } catch (err) {
    if (request !== deviceRequest) return;
    devicesLoaded = false;
    statusEl.title = 'device discovery failed: ' + err.message;
  }
}

function renderDevices() {
  const previous = deviceSel.value;
  deviceSel.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  const matched = autoDeviceForTarget();
  auto.textContent = matched ? 'Auto · ' + matched.name : 'Auto · no matching device';
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

/** Preview the same device preference used by DeviceRegistry.resolveForName. */
function autoDeviceForTarget() {
  const [root, name = ''] = picker.value.split('\u0000');
  const project = projects.find((p) => p.root === (root || selectedRoot));
  const target = project?.targets.find((t) => t.name === name);
  if (target?.deviceId) {
    const exact = devices.find((d) => d.id === target.deviceId);
    if (exact) return exact;
  }

  const lower = name.toLowerCase();
  let candidates = devices;
  if (/\bipad\b/.test(lower)) candidates = devices.filter((d) => d.platformType === 'ios' && d.emulator && /ipad/i.test(d.name));
  else if (/\bphysical\b/.test(lower)) candidates = devices.filter((d) => d.platformType === (/\bandroid\b/.test(lower) ? 'android' : 'ios') && !d.emulator);
  else if (/\b(web|chrome)\b/.test(lower)) candidates = devices.filter((d) => d.platformType === 'web');
  else if (/\bandroid\b/.test(lower)) candidates = devices.filter((d) => d.platformType === 'android');
  else if (/\b(ios|iphone|simulator)\b/.test(lower)) candidates = devices.filter((d) => d.platformType === 'ios' && d.emulator);
  else if (/\b(macos|desktop|windows|linux)\b/.test(lower)) candidates = devices.filter((d) => d.category === 'desktop');
  else candidates = devices.toSorted((a, b) => {
    const rank = (d) => ((d.platformType === 'ios' || d.platformType === 'android') ? (d.emulator ? 0 : 1) : d.platformType === 'web' ? 2 : d.category === 'desktop' ? 3 : 4);
    return rank(a) - rank(b);
  });
  return candidates[0];
}

deviceSel.onchange = () => {
  if (deviceSel.value !== 'refresh') return;
  deviceSel.value = '';
  toast('looking for devices…');
  loadDevices(true);
};

async function loadCheckouts(force) {
  const cwd = launchRoot();
  if (checkoutsLoaded && checkoutRoot === cwd && !force) return;
  const request = ++checkoutRequest;
  checkoutRoot = cwd;
  checkoutsLoaded = true;
  checkouts = [{ id: 'inplace', kind: 'inplace', label: 'This checkout', group: 'this' }];
  renderCheckouts();
  try {
    const listed = await call('checkouts', { cwd });
    if (request !== checkoutRequest) return;
    checkouts = listed ?? [];
    renderCheckouts();
  } catch (err) {
    if (request !== checkoutRequest) return;
    checkoutsLoaded = false;
    checkouts = [{ id: 'inplace', kind: 'inplace', label: 'This checkout', group: 'this' }];
    renderCheckouts();
    statusEl.title = 'checkout list failed: ' + err.message;
    return;
  }
  call('checkouts', { cwd, fetch: true }).then((listed) => {
    if (request !== checkoutRequest) return;
    checkouts = listed ?? checkouts;
    renderCheckouts();
  }).catch(() => {});
}

function renderCheckouts() {
  if (!checkoutSel) return;
  const previous = checkoutSel.value;
  checkoutSel.innerHTML = '';
  const groups = { this: null, worktrees: 'Worktrees', local: 'Local', remote: 'Remote' };
  const buckets = { this: [], worktrees: [], local: [], remote: [] };
  for (const entry of checkouts) {
    (buckets[entry.group] || buckets.this).push(entry);
  }
  for (const group of ['this', 'worktrees', 'local', 'remote']) {
    const items = buckets[group];
    if (!items.length) continue;
    const parent = groups[group]
      ? Object.assign(document.createElement('optgroup'), { label: groups[group] })
      : checkoutSel;
    for (const entry of items) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      option.title = entry.cwd || entry.ref || entry.label;
      parent.appendChild(option);
    }
    if (groups[group] && items.length) checkoutSel.appendChild(parent);
  }
  if (previous) checkoutSel.value = previous;
  if (!checkoutSel.value) checkoutSel.value = 'inplace';
  renderLaunchGuide();
}

// The launch target owns its context even when the All tab is selected.
function launchRoot() { return picker.value.split('\u0000')[0] || selectedRoot; }
picker.addEventListener('change', () => { renderDevices(); loadDevices(); loadCheckouts(); renderLaunchGuide(); });
checkoutSel.addEventListener('change', renderLaunchGuide);

function renderLaunchGuide() {
  const panel = $('launchGuide');
  if (!panel) return;
  const [root, name] = picker.value.split('\u0000');
  const project = projects.find((p) => p.root === (root || selectedRoot));
  const target = project?.targets.find((t) => t.name === name);
  const report = project?.inspection;
  panel.replaceChildren();
  const line = (text, cls) => {
    const el = document.createElement('div');
    el.textContent = text; if (cls) el.className = cls;
    panel.appendChild(el);
  };
  line(target ? (target.issues.length ? 'Needs setup' : 'Ready to launch') + ' · ' + target.name : 'Choose a project and launch target', 'guide-title');
  if (project) line(project.root, 'guide-path');
  if (target) {
    line('Source: ' + (target.sourceFile || target.source) + (target.program ? ' · ' + target.program : '') + (target.mode ? ' · ' + target.mode : ''));
    if (target.capture) line('Network: ' + target.capture);
    if (target.deviceId) line('Default device: ' + target.deviceId + '. Selecting a device overrides this default.');
    for (const issue of target.issues) line(issue.path + ' — ' + issue.hint, 'guide-warning');
    for (const warning of target.warnings || []) line(warning, 'guide-warning');
  }
  for (const diagnostic of report?.diagnostics || []) line(diagnostic.file + ': ' + diagnostic.message, 'guide-warning');
  if (project?.error) line(project.error, 'guide-warning');
  if (checkoutSel.value && checkoutSel.value !== 'inplace') line('Branch/worktree launch: targets above describe this project folder. Baton re-reads the chosen checkout at launch; its config must contain this target.', 'guide-warning');
  if (report?.guidanceFiles.length) line('Project guidance: ' + report.guidanceFiles.join(', '));
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Launch & validation guide';
  details.appendChild(summary);
  const steps = document.createElement('ol');
  for (const step of report?.steps || ['Add a project folder with launch.json, package.json or pubspec.yaml.']) {
    const li = document.createElement('li'); li.textContent = step; steps.appendChild(li);
  }
  details.appendChild(steps); panel.appendChild(details);
  if (report) line('Synced from disk · ' + report.revision, 'guide-path');
}
$('refreshProjects').onclick = async () => {
  projectFingerprint = null;
  await loadProjects();
  loadCheckouts(true);
};
addEventListener('focus', () => loadProjects());
setInterval(() => { if (socket?.readyState === 1 && !document.hidden) loadProjects(); }, 3000);

// --- running --------------------------------------------------------------

$('run').onclick = async () => {
  const value = picker.value;
  if (!value) return;
  const [root, target] = value.split('\u0000');
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
    const pick = checkoutSel ? checkoutSel.value : 'inplace';
    let branch, checkout;
    if (pick && pick.startsWith('worktree:')) checkout = pick.slice('worktree:'.length);
    else if (pick && pick.startsWith('ref:')) branch = pick.slice('ref:'.length);
    await call('run', { target, cwd: root, deviceId, branch, checkout });
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
};

$('reloadAll').onclick = () => act('reload', scopedAll());
$('restartAll').onclick = () => act('restart', scopedAll());
$('stopAll').onclick = () => {
  const shouldConfirm = !window.BatonSettings || window.BatonSettings.confirmStopAll();
  if (shouldConfirm && !window.confirm('Stop every running session in view?')) return;
  act('stop', scopedAll());
};

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
        return toast([first.message, ...(first.errors ?? []).slice(0, 3)].filter(Boolean).join('\n'), true);
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
    paintPeek();
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
  const hog = heaviestId(all);
  for (const [root, group] of groups) {
    if (labelled) {
      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = basename(root) || 'unknown project';
      title.title = root;
      list.appendChild(title);
    }
    for (const s of group) list.appendChild(renderRow(s, hog));
  }
  paintPeek();
}

function heaviestId(list) {
  let best = null, bestRss = -1;
  for (const s of list) {
    if (s.status !== 'running' && s.status !== 'starting') continue;
    if (s.rssBytes == null) continue;
    if (s.rssBytes > bestRss) {
      bestRss = s.rssBytes;
      best = s.id;
    }
  }
  return best;
}

function renderRow(s, hog) {
  const can = (c) => s.capabilities.includes(c);
  const live = s.status === 'running';
  const heavy = hog && s.id === hog;

  const row = document.createElement('div');
  row.className = 'row' + (heavy ? ' heavy' : '');

  const top = document.createElement('div');
  top.className = 'row-top';
  top.innerHTML =
    '<span class="dot ' + s.status + '"></span>' +
    '<span class="name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
    '<span class="tag">' + esc(s.kind) + '</span><span class="spacer"></span>';
  top.querySelector('.name').onclick = () => setActiveSession(s.id);
  if (s.id === activeSessionId) row.classList.add('active');

  const button = (label, title, enabled, onClick, cls) => {
    const b = document.createElement('button');
    b.className = 'icon ' + (cls || '');
    b.textContent = label;
    b.title = title;
    b.disabled = !enabled;
    b.onclick = onClick;
    return b;
  };

  top.appendChild(iconButton('reload', can('hotReload') ? 'Hot reload (keeps state)'
    : 'Hot reload not available for ' + s.kind, live && can('hotReload'),
    () => act('reload', { session: s.id })));
  top.appendChild(iconButton('restart', can('hotRestart') || can('restartProcess')
    ? 'Hot restart' : 'Restart not available', live && (can('hotRestart') || can('restartProcess')),
    () => act('restart', { session: s.id })));
  top.appendChild(iconButton('stop', 'Stop', live || s.status === 'starting',
    () => act('stop', { session: s.id }), 'danger'));
  if (s.status === 'stopped' || s.status === 'failed') {
    top.appendChild(iconButton('close',
      s.checkout && s.checkout.kind === 'owned'
        ? 'Dismiss and delete this branch copy'
        : 'Dismiss from the list',
      true, async () => {
        try {
          await call('forget', { session: s.id });
          sessions.delete(s.id);
          render();
        } catch (err) { toast(err.message, true); }
      }, 'danger'));
  }
  top.appendChild(iconButton('logs', 'Toggle logs', true, () => toggleLogs(s.id)));

  if (s.url) top.appendChild(iconButton('external', 'Open ' + s.url, true, () => window.open(s.url, '_blank')));
  if (s.devToolsUri) {
    top.appendChild(iconButton('inspect', 'Open DevTools', true, () => window.open(s.devToolsUri, '_blank')));
  }
  row.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [s.status];
  if (s.progress) bits.push(s.progress);
  if (s.checkout && s.checkout.kind !== 'inplace') bits.push(s.checkout.ref || s.checkout.cwd);
  if (s.target) bits.push(deviceName(s.target));
  if (s.rssBytes != null) bits.push(humanSize(s.rssBytes));
  if (s.cpuPct != null) bits.push(Math.round(s.cpuPct) + '%');
  if (s.exitCode !== undefined && s.exitCode !== null) bits.push('exit ' + s.exitCode);
  meta.textContent = bits.join('  ·  ');
  if (heavy) {
    const tag = document.createElement('span');
    tag.className = 'tag heaviest';
    tag.textContent = 'heaviest';
    tag.title = 'This run is using the most memory of the live sessions';
    meta.appendChild(document.createTextNode('  '));
    meta.appendChild(tag);
  }
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

  hook('row', s, { row, top, button, iconButton });
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

async function hydrateLogs(id) {
  try {
    const lines = await call('logs', { session: id, tail: 400 });
    logBuffers.set(id, lines.map((l) => ({ text: l.text, error: l.error })));
  } catch { /* keep whatever was streamed */ }
}

function setActiveSession(id) {
  activeSessionId = id || null;
  paintPeek();
  hook('sessionFocus', id);
}

const DENSITY_KEY = 'baton.density';
const DENSITY_SIZE = {
  chip: { width: 64, height: 64 },
  peek: { width: 348, height: 76 },
  inspector: { width: 980, height: 680 },
};
let densityTimer = 0;

function densitySize(name) {
  if (name !== 'inspector') return DENSITY_SIZE[name];
  const availableWidth = Number(screen.availWidth) || DENSITY_SIZE.inspector.width;
  const availableHeight = Number(screen.availHeight) || DENSITY_SIZE.inspector.height;
  return {
    width: Math.min(980, Math.max(620, availableWidth - 48)),
    height: Math.min(680, Math.max(520, availableHeight - 64)),
  };
}

function paintDensity(name) {
  document.body.dataset.density = name;
  const expand = $('chipExpand');
  if (expand) {
    expand.title = name === 'inspector' ? 'Minimize to chip' : 'Expand inspector';
    fillIcon(expand, name === 'inspector' ? 'minimize' : 'expand');
  }
}

function setDensity(name, persist) {
  if (name !== 'chip' && name !== 'peek' && name !== 'inspector') return;
  clearTimeout(densityTimer);
  if (persist && name !== 'peek') {
    try { localStorage.setItem(DENSITY_KEY, name); } catch { /* private mode */ }
  }
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.batonHud;
  if (!handler) {
    paintDensity(name);
    hook('density', name);
    return;
  }

  const sendResize = () => {
    const size = densitySize(name);
    handler.postMessage({ type: 'resize', width: size.width, height: size.height, pin: 'trailing', density: name });
  };
  const current = document.body.dataset.density;
  if (name === 'inspector' && current !== 'inspector') {
    // Grow the native window around the anchored chip, then reveal the dense UI.
    document.body.dataset.transition = 'opening';
    sendResize();
    densityTimer = setTimeout(() => {
      paintDensity(name);
      delete document.body.dataset.transition;
    }, 170);
  } else if (name === 'chip' && current === 'inspector') {
    // Fade controls first; the chip then stays planted while the window shrinks.
    document.body.dataset.transition = 'closing';
    densityTimer = setTimeout(() => {
      paintDensity(name);
      sendResize();
      delete document.body.dataset.transition;
    }, 90);
  } else {
    paintDensity(name);
    sendResize();
  }
  hook('density', name);
}

function paintPeek() {
  const live = [...sessions.values()].filter((s) => s.status === 'running' || s.status === 'starting');
  const failed = [...sessions.values()].some((s) => s.status === 'failed');
  const starting = live.some((s) => s.status === 'starting');
  const count = $('chipCount');
  const mark = $('chipMark');
  const face = $('chipFace');
  const state = failed ? 'failed' : starting ? 'starting' : live.length ? 'running' : 'idle';
  if (count) count.textContent = live.length ? String(live.length) : '';
  if (mark) mark.className = 'chip-mark' + (state === 'idle' ? '' : ' ' + state);
  if (face) face.dataset.state = state;

  const all = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (!activeSessionId || !sessions.has(activeSessionId)) {
    activeSessionId = (live[0] || all[all.length - 1] || {}).id || null;
  }

  const sel = $('peekSession');
  const meta = $('peekMeta');
  const actions = $('peekActions');
  if (!sel || !actions) return;

  const previous = sel.value;
  sel.innerHTML = '';
  if (!all.length) {
    sel.innerHTML = '<option value="">No session</option>';
    meta.textContent = '';
    actions.textContent = '';
    actions.appendChild(iconButton('run', 'Run the selected target', true, () => $('run').click()));
    return;
  }
  for (const s of all) {
    const option = document.createElement('option');
    option.value = s.id;
    option.textContent = s.name;
    sel.appendChild(option);
  }
  if (activeSessionId) sel.value = activeSessionId;
  else if (previous && sessions.has(previous)) sel.value = previous;
  const current = sessions.get(sel.value);
  if (current) activeSessionId = current.id;
  meta.textContent = current ? current.status : '';

  actions.textContent = '';
  if (current) {
    const can = (c) => current.capabilities.includes(c);
    const liveNow = current.status === 'running';
    actions.appendChild(iconButton('reload', 'Hot reload (keeps state)', liveNow && can('hotReload'),
      () => act('reload', { session: current.id })));
    actions.appendChild(iconButton('restart', 'Hot restart', liveNow && (can('hotRestart') || can('restartProcess')),
      () => act('restart', { session: current.id })));
    actions.appendChild(iconButton('stop', 'Stop', liveNow || current.status === 'starting',
      () => act('stop', { session: current.id }), 'danger'));
  }
  actions.appendChild(iconButton('run', 'Run the selected target', true, () => $('run').click(), 'go'));
}

function wireChip() {
  const chip = $('chip');
  const face = $('chipFace');
  const expand = $('chipExpand');
  if (!chip || !face || !expand) return;
  fillIcon(expand, 'expand');

  const toggle = () => {
    const open = document.body.dataset.density === 'inspector';
    setDensity(open ? 'chip' : 'inspector', true);
  };
  expand.onclick = (e) => { e.stopPropagation(); toggle(); };
  face.onclick = toggle;
  face.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  };

  $('peekSession').onchange = () => setActiveSession($('peekSession').value);
}

function restoreDensity() {
  if (new URLSearchParams(location.search).get('density') === 'inspector') {
    setDensity('inspector', false);
    return;
  }
  let saved = 'chip';
  try { saved = localStorage.getItem(DENSITY_KEY) || 'chip'; } catch { /* private mode */ }
  const startupView = storedPreferences().startupView;
  if (startupView === 'chip' || startupView === 'inspector') saved = startupView;
  if (saved !== 'inspector') saved = 'chip';
  setDensity(saved, false);
}

// Keyboard shortcuts mirroring the flutter run terminal: r reload, R restart.
addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable || e.metaKey || e.ctrlKey) return;
  if (e.key === 'Escape' && e.target.blur) e.target.blur();
  if (e.key === 'r') act('reload', scopedAll());
  if (e.key === 'R') act('restart', scopedAll());
});

if (new URLSearchParams(location.search).get('chrome') === 'panel') {
  document.body.classList.add('panel');
}

fillIcon($('reloadAll'), 'reload');
fillIcon($('restartAll'), 'restart');
fillIcon($('stopAll'), 'stop');
const runBtn = $('run');
if (runBtn && !runBtn.querySelector('.ico')) {
  runBtn.prepend(iconEl('run'));
}
wireChip();
restoreDensity();
paintPeek();

connect();

/** Refresh rss/cpu without a second websocket; one `ps -p` on the daemon. */
async function refreshResources() {
  const live = [...sessions.values()].filter((s) => s.status === 'running' || s.status === 'starting');
  if (!live.length) return;
  try {
    const list = await call('sessions');
    let changed = false;
    for (const s of list) {
      const current = sessions.get(s.id);
      if (!current) continue;
      if (current.rssBytes === s.rssBytes && current.cpuPct === s.cpuPct && current.pid === s.pid) continue;
      sessions.set(s.id, { ...current, pid: s.pid, rssBytes: s.rssBytes, cpuPct: s.cpuPct });
      changed = true;
    }
    if (changed) render();
  } catch { /* daemon offline */ }
}
setInterval(refreshResources, 2000);
