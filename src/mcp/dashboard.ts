import type { SessionSnapshot } from '../core/types.ts';

/**
 * The Baton card a chat host draws inline (an MCP App, `text/html;profile=mcp-app`).
 *
 * `show_dashboard` returns the runs as `structuredContent` and points at this
 * page; the page then refreshes and acts through `dashboard_action`, so the
 * buttons press the same daemon methods the other tools do. Self-contained:
 * no scripts or fonts from the network, because hosts sandbox these frames.
 */
export const DASHBOARD_URI = 'ui://baton/dashboard.html';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

export type DashboardRun = {
  id: string;
  name: string;
  project: string;
  kind: string;
  status: SessionSnapshot['status'];
  device?: string;
  url?: string;
  progress?: string;
  cpuPct?: number;
  rssBytes?: number;
  capabilities: string[];
};

export type DashboardState = {
  runs: DashboardRun[];
  at: number;
  message?: string;
  /** Last screenshot taken from the card, as a PNG data URL. */
  shot?: { session: string; name: string; dataUrl: string };
};

export function toDashboardRun(s: SessionSnapshot, devices: Map<string, string>): DashboardRun {
  const root = (s.root ?? '').replace(/[\\/]+$/, '');
  const known = s.target ? devices.get(s.target) : undefined;
  const device = known ?? (s.target && !/^(https?:|web|chrome|edge|browser)/i.test(s.target) && s.target.length <= 24 ? s.target : undefined);
  return {
    id: s.id,
    name: s.name,
    project: root.split(/[\\/]/).pop() || s.name,
    kind: s.kind,
    status: s.status,
    device,
    url: s.url,
    progress: s.progress,
    cpuPct: s.cpuPct,
    rssBytes: s.rssBytes,
    capabilities: s.capabilities,
  };
}

/** One line per run, for the model and for hosts that draw no card. */
export function dashboardText(state: DashboardState): string {
  if (state.runs.length === 0) return 'Baton: nothing is running.';
  const lines = state.runs.map((r) => {
    const where = r.device ?? r.url ?? r.kind;
    return `${r.status === 'running' ? '●' : r.status === 'failed' ? '✕' : '○'} ${r.project}/${r.name} · ${where} · ${r.status}`;
  });
  return [`Baton: ${state.runs.filter((r) => r.status === 'running').length} running`, ...lines].join('\n');
}

export function dashboardHtml(version: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baton</title>
<style>
:root{--bg:#ffffff;--card:#f6f7fb;--line:#e3e6ee;--fg:#141824;--muted:#5d6577;--ok:#0e9f6e;--warn:#b7791f;--err:#d64545;--accent:#4f46e5;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1a1b1f;--card:#23252b;--line:#33363f;--fg:#eef0f5;--muted:#9aa1b2;--ok:#34d399;--warn:#fbbf24;--err:#f87171;--accent:#818cf8;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.wrap{padding:14px;display:grid;gap:10px}
header{display:flex;align-items:center;gap:8px}
header b{font-size:15px}
.count{color:var(--muted);font-size:13px}
header .sp{flex:1}
button{font:inherit;font-size:12.5px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.run{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:grid;gap:6px}
.top{display:flex;align-items:center;gap:8px;min-width:0}
.dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--muted)}
.running .dot{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
.starting .dot{background:var(--warn)}
.failed .dot{background:var(--err)}
.name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.where{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{color:var(--muted);font-size:12.5px}
.acts{display:flex;flex-wrap:wrap;gap:6px}
.empty{color:var(--muted);padding:6px 0}
.msg{font-size:12.5px;color:var(--muted)}
.msg.err{color:var(--err)}
figure{margin:0;display:grid;gap:6px;justify-items:center}
figure img{max-width:220px;max-height:420px;border-radius:14px;border:1px solid var(--line)}
figcaption{font-size:12px;color:var(--muted)}
</style></head>
<body><div class="wrap">
<header><b>Baton</b><span class="count" id="count"></span><span class="sp"></span><button id="reloadAll" hidden>Reload all</button><button id="refresh">Refresh</button></header>
<div id="runs"></div>
<div class="msg" id="msg"></div>
<figure id="shot" hidden><img id="shotImg" alt=""><figcaption id="shotCap"></figcaption></figure>
</div>
<script>
(() => {
  const parent = window.parent;
  let nextId = 1;
  const pending = new Map();
  let state = { runs: [], at: 0 };
  let busy = null;

  function send(msg) { parent.postMessage({ jsonrpc: '2.0', ...msg }, '*'); }
  function request(method, params) {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.delete(id)) reject(new Error('timed out')); }, 120000);
    });
  }
  function notify(method, params) { send({ method, params }); }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message || 'error')) : p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') take(m.params);
    if (m.method === 'ui/resource-teardown' && m.id !== undefined) send({ id: m.id, result: {} });
  });

  function take(result) {
    const s = result && result.structuredContent;
    if (s && Array.isArray(s.runs)) { state = { ...s, shot: s.shot || state.shot }; draw(); }
    else if (result && result.isError) { say(textOf(result), true); }
  }
  function textOf(r) { return (r && r.content || []).map(c => c.text || '').join(' ').trim(); }
  function say(text, isErr) { const el = document.getElementById('msg'); el.textContent = text || ''; el.className = 'msg' + (isErr ? ' err' : ''); size(); }

  async function act(action, session, label) {
    const quiet = action === 'refresh';
    if (!quiet) { busy = (session || '') + ':' + action; draw(); }
    try {
      const r = await request('tools/call', { name: 'dashboard_action', arguments: session ? { action, session } : { action } });
      take(r);
      if (r && !r.isError && label) say(label);
    } catch (e) { say('Baton: ' + e.message, true); }
    if (!quiet) { busy = null; draw(); }
  }

  function mb(b) { return b == null ? '' : Math.round(b / 1048576) + ' MB'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function draw() {
    const runs = state.runs || [];
    const live = runs.filter(r => r.status === 'running');
    document.getElementById('count').textContent = runs.length ? live.length + ' running' : '';
    const reloadable = live.filter(r => r.capabilities.includes('hotReload'));
    const ra = document.getElementById('reloadAll');
    ra.hidden = reloadable.length === 0; ra.disabled = !!busy;
    ra.textContent = busy === ':reload_all' ? 'Reloading…' : 'Reload all';
    const box = document.getElementById('runs');
    if (!runs.length) { box.innerHTML = '<div class="empty">Nothing is running. Ask Claude to run an app and it shows here.</div>'; size(); return; }
    box.innerHTML = runs.map(r => {
      const can = c => r.status === 'running' && r.capabilities.includes(c);
      const stats = r.status === 'running' ? [r.cpuPct != null ? Math.round(r.cpuPct) + '% CPU' : '', mb(r.rssBytes)].filter(Boolean).join(' · ') : (r.progress || r.status);
      const b = (a, text, busyText) => '<button data-a="' + a + '" data-s="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy === r.id + ':' + a ? busyText : text) + '</button>';
      return '<div class="run ' + esc(r.status) + '">'
        + '<div class="top"><span class="dot"></span><span class="name">' + esc(r.project === r.name ? r.name : r.project + ' · ' + r.name) + '</span></div>'
        + '<div class="where">' + esc([r.device, r.url, r.kind].filter(Boolean).join(' · ')) + '</div>'
        + '<div class="meta">' + esc(stats) + '</div>'
        + '<div class="acts">'
        + (can('hotReload') ? b('reload', 'Reload', 'Reloading…') : '')
        + (can('hotRestart') || can('restartProcess') ? b('restart', 'Restart', 'Restarting…') : '')
        + (can('screenshot') ? b('screenshot', 'Screenshot', 'Capturing…') : '')
        + (r.status === 'running' || r.status === 'starting' ? b('stop', 'Stop', 'Stopping…') : '')
        + '</div></div>';
    }).join('');
    const f = document.getElementById('shot');
    if (state.shot) {
      f.hidden = false;
      document.getElementById('shotImg').src = state.shot.dataUrl;
      document.getElementById('shotImg').alt = 'Screenshot of ' + state.shot.name;
      document.getElementById('shotCap').textContent = state.shot.name;
    }
    size();
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button[data-a]');
    if (t) { const a = t.dataset.a; const r = state.runs.find(x => x.id === t.dataset.s); act(a, t.dataset.s, r ? labels[a] + ' ' + r.name : ''); }
  });
  const labels = { reload: 'Reloaded', restart: 'Restarted', screenshot: 'Captured', stop: 'Stopped' };
  document.getElementById('refresh').onclick = () => act('refresh');
  document.getElementById('reloadAll').onclick = () => act('reload_all', null, 'Reloaded every running app');
  document.getElementById('shotImg').onload = size;

  let lastH = 0;
  function size() {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h !== lastH) { lastH = h; notify('ui/notifications/size-changed', { height: h }); }
  }

  request('ui/initialize', {
    protocolVersion: '2025-11-21',
    appInfo: { name: 'Baton', version: '${version}' },
    appCapabilities: {},
  }).then(() => {
    notify('ui/notifications/initialized', {});
    draw();
    // Live without a model turn: the card asks the server, not Claude.
    setInterval(() => { if (!busy && !document.hidden) act('refresh'); }, 3000);
  }).catch(() => draw());
})();
</script></body></html>`;
}
