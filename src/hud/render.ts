/**
 * The floating control surface, served by the daemon.
 *
 * Deliberately a single self-contained page with no build step and no external
 * requests: it has to work identically on macOS, Linux and Windows, and open
 * instantly in whatever browser is around. Open it in a small always-on-top
 * window (`clilaunch hud`) and it behaves like an IDE's debug toolbar.
 */
export function renderHud(token: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CLI-Launch</title>
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
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    background: var(--panel); border-bottom: 1px solid var(--line);
    position: sticky; top: 0; z-index: 5;
  }
  .brand { font-weight: 650; letter-spacing: -0.01em; margin-right: auto; }
  .brand small { color: var(--muted); font-weight: 400; margin-left: 6px; }
  button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 5px 9px; font: inherit; font-size: 12px;
    cursor: pointer; white-space: nowrap;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .35; cursor: not-allowed; }
  button.icon { font-size: 14px; padding: 4px 8px; line-height: 1; }
  button.danger:hover:not(:disabled) { border-color: var(--err); color: var(--err); }
  main { padding: 8px; display: grid; gap: 8px; }
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
  .spacer { margin-left: auto; }
  .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px;
  }
  .empty { color: var(--muted); text-align: center; padding: 28px 12px; }
  .empty h2 { font-size: 14px; margin: 0 0 6px; color: var(--text); }
  select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 5px 7px; font: inherit; font-size: 12px; max-width: 260px;
  }
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
    pointer-events: none; max-width: 92vw; z-index: 20;
  }
  .toast.show { opacity: 1; }
  .toast.bad { border-color: var(--err); color: var(--err); }
</style>
</head>
<body>
<header>
  <div class="brand">CLI-Launch <small id="status">connecting…</small></div>
  <select id="picker"><option value="">Loading targets…</option></select>
  <button id="run">Run</button>
  <button class="icon" id="reloadAll" title="Hot reload every running session">⟳</button>
  <button class="icon" id="restartAll" title="Hot restart every running session">⟲</button>
  <button class="icon danger" id="stopAll" title="Stop every running session">■</button>
</header>
<main id="list"></main>
<div class="toast" id="toast"></div>

<script>
const TOKEN = ${JSON.stringify(token)};
const list = document.getElementById('list');
const picker = document.getElementById('picker');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');

let socket, nextId = 1, sessions = new Map(), openLogs = new Set();
const pending = new Map();
const logBuffers = new Map();

function toast(text, bad) {
  toastEl.textContent = text;
  toastEl.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.className = 'toast'), 3200);
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function connect() {
  socket = new WebSocket(\`ws://\${location.host}?token=\${TOKEN}\`);
  socket.onopen = () => { statusEl.textContent = 'connected'; loadTargets(); };
  socket.onclose = () => {
    statusEl.textContent = 'daemon offline — retrying';
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
    if (msg.event === 'hello') { sessions = new Map(msg.sessions.map(s => [s.id, s])); render(); }
    if (msg.event === 'session') { sessions.set(msg.snapshot.id, msg.snapshot); render(); }
    if (msg.event === 'log') appendLog(msg);
  };
}

function appendLog({ sessionId, text, error }) {
  let buffer = logBuffers.get(sessionId);
  if (!buffer) logBuffers.set(sessionId, (buffer = []));
  buffer.push({ text, error });
  if (buffer.length > 400) buffer.splice(0, buffer.length - 400);
  if (!openLogs.has(sessionId)) return;
  const pane = document.querySelector(\`[data-logs="\${sessionId}"]\`);
  if (!pane) return;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  const line = document.createElement('div');
  if (error) line.className = 'err';
  line.textContent = text;
  pane.appendChild(line);
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

async function loadTargets() {
  try {
    const { targets, root } = await call('targets', { cwd: null });
    picker.innerHTML = '';
    if (!targets.length) {
      picker.innerHTML = '<option value="">No targets found</option>';
      return;
    }
    for (const t of targets) {
      const option = document.createElement('option');
      option.value = t.name;
      option.textContent = t.name + '  ·  ' + t.kind;
      picker.appendChild(option);
    }
    statusEl.textContent = root.split(/[\\\\/]/).pop();
  } catch (err) { toast(err.message, true); }
}

function render() {
  const all = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (!all.length) {
    list.innerHTML = '<div class="empty"><h2>Nothing running</h2>' +
      'Pick a target above and press Run — or start one from a terminal with ' +
      '<code>clilaunch run &lt;name&gt;</code>.</div>';
    return;
  }
  list.innerHTML = '';
  for (const s of all) list.appendChild(renderRow(s));
}

function renderRow(s) {
  const can = (c) => s.capabilities.includes(c);
  const live = s.status === 'running';

  const row = document.createElement('div');
  row.className = 'row';

  const top = document.createElement('div');
  top.className = 'row-top';
  top.innerHTML =
    \`<span class="dot \${s.status}"></span>\` +
    \`<span class="name" title="\${esc(s.name)}">\${esc(s.name)}</span>\` +
    \`<span class="tag">\${esc(s.kind)}</span><span class="spacer"></span>\`;

  const button = (label, title, enabled, onClick, cls = '') => {
    const b = document.createElement('button');
    b.className = 'icon ' + cls;
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

  if (s.url) {
    top.appendChild(button('↗', 'Open ' + s.url, true, () => window.open(s.url, '_blank')));
  }
  if (s.devToolsUri) {
    top.appendChild(button('⚙', 'Open DevTools', true, () => window.open(s.devToolsUri, '_blank')));
  }
  row.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [s.status];
  if (s.progress) bits.push(s.progress);
  if (s.target) bits.push(s.target);
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

async function toggleLogs(id) {
  if (openLogs.has(id)) { openLogs.delete(id); render(); return; }
  openLogs.add(id);
  try {
    const lines = await call('logs', { session: id, tail: 300 });
    logBuffers.set(id, lines.map(l => ({ text: l.text, error: l.error })));
  } catch { /* keep whatever was streamed */ }
  render();
}

async function act(method, params) {
  try {
    const result = await call(method, params);
    if (Array.isArray(result)) {
      const failed = result.filter(r => r.code && r.code !== 0);
      if (failed.length) return toast(failed[0].message || 'failed', true);
      const first = result[0];
      if (first?.message) toast(first.message);
    }
  } catch (err) { toast(err.message, true); }
}

const esc = (s) => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

document.getElementById('run').onclick = async () => {
  if (!picker.value) return;
  try { await call('run', { target: picker.value, cwd: null }); }
  catch (err) { toast(err.message, true); }
};
document.getElementById('reloadAll').onclick = () => act('reload', { all: true });
document.getElementById('restartAll').onclick = () => act('restart', { all: true });
document.getElementById('stopAll').onclick = () => act('stop', { all: true });

// Keyboard shortcuts mirroring the flutter run terminal: r reload, R restart.
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
  if (e.key === 'r') act('reload', { all: true });
  if (e.key === 'R') act('restart', { all: true });
});

connect();
</script>
</body>
</html>`;
}
