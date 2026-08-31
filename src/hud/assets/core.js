const TOKEN = window.BATON_TOKEN;
const $ = (id) => document.getElementById(id);
const list = $('list'), picker = $('picker'), deviceSel = $('device');
const tabs = $('tabs'), statusEl = $('status'), toastEl = $('toast');
const historyBtn = $('historyBtn'), historyPanel = $('historyPanel');
const historyList = $('historyList'), historyLogs = $('historyLogs');

let socket, nextId = 1;
let sessions = new Map();
let activeSessionId = null; // session the peek strip and inspector follow
let projects = [];          // [{root, name, targets, error}]
let selectedRoot = null;    // null = show every project at once
let devices = [];           // connected, runnable now
let bootables = [];         // not running, but startable
let devicesLoaded = false;
const openLogs = new Set();
const pending = new Map();
const logBuffers = new Map();

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
const addons = [];
window.baton = {
  call, toast, esc, humanSize, iconEl, iconButton,
  extend(addon) { addons.push(addon); render(); },

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
    el.title = project.root + (project.error ? '\n⚠ ' + project.error : '');
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
  renderTabs();
  renderPicker();
  render();
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
  } else if (previous) {
    picker.value = previous; // keep the selection across re-renders
  }
  statusEl.textContent = selectedRoot ? basename(selectedRoot) : projects.length + ' projects';
}

/**
 * Fill the device menu: what can be run on now, and what can be started.
 *
 * Discovery spawns a `flutter daemon`, so it is done once in the background and
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
  paintPeek();
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
  chip: { width: 64, height: 76 },
  peek: { width: 348, height: 76 },
  inspector: { width: 980, height: 680 },
};

function setDensity(name, persist) {
  if (name !== 'chip' && name !== 'peek' && name !== 'inspector') return;
  document.body.dataset.density = name;
  const expand = $('chipExpand');
  if (expand) {
    expand.title = name === 'inspector' ? 'Minimize to chip' : 'Expand inspector';
    fillIcon(expand, name === 'inspector' ? 'minimize' : 'expand');
  }
  if (persist && name !== 'peek') {
    try { localStorage.setItem(DENSITY_KEY, name); } catch { /* private mode */ }
  }
  const size = DENSITY_SIZE[name];
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.batonHud;
  if (handler) handler.postMessage({ type: 'resize', width: size.width, height: size.height, pin: 'trailing' });
  hook('density', name);
}

function paintPeek() {
  const live = [...sessions.values()].filter((s) => s.status === 'running' || s.status === 'starting');
  const failed = [...sessions.values()].some((s) => s.status === 'failed');
  const starting = live.some((s) => s.status === 'starting');
  const count = $('chipCount');
  const dot = $('chipDot');
  if (count) count.textContent = String(live.length);
  if (dot) {
    dot.className = 'dot' + (failed ? ' failed' : starting ? ' starting' : live.length ? ' running' : '');
  }

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
  const expand = $('chipExpand');
  if (!chip || !expand) return;
  fillIcon(expand, 'expand');
  expand.onclick = (e) => {
    e.stopPropagation();
    const open = document.body.dataset.density === 'inspector';
    setDensity(open ? 'chip' : 'inspector', true);
  };

  let linger;
  chip.addEventListener('mouseenter', () => {
    if (document.body.dataset.density === 'inspector') return;
    clearTimeout(linger);
    setDensity('peek', false);
  });
  chip.addEventListener('mouseleave', () => {
    if (document.body.dataset.density === 'inspector') return;
    linger = setTimeout(() => setDensity('chip', false), 180);
  });

  $('peekSession').onchange = () => setActiveSession($('peekSession').value);
}

function restoreDensity() {
  let saved = 'chip';
  try { saved = localStorage.getItem(DENSITY_KEY) || 'chip'; } catch { /* private mode */ }
  if (saved !== 'inspector') saved = 'chip';
  setDensity(saved, false);
}

// Keyboard shortcuts mirroring the flutter run terminal: r reload, R restart.
addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || e.metaKey || e.ctrlKey) return;
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
