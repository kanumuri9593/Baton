// network inspector pane — Phase 1 track B
//
// A Proxyman-style view of what the app is talking to, inside the HUD: the
// requests a Flutter app makes over dart:io arrive as pushed events and land in
// a table you can filter, expand, and copy as a cURL command.
//
// Hooks into core.js through `window.baton.extend` rather than being wired into
// it, so this whole feature is one file plus its stylesheet block.
(function () {
  const { call, toast, esc, humanSize, extend } = window.baton;

  /** Matches the daemon's own per-session cap; a HUD row is worth less than a MB of DOM. */
  const CAP = 500;

  /** What capture can see, said wherever the feature is offered. */
  const COVERAGE =
    'Flutter: dart:io HTTP. Node opt-in: OpenTelemetry HTTP/HTTPS and fetch metadata.\n' +
    'Node capture excludes bodies, headers and URL queries; browser-only traffic and raw sockets are not captured.';

  const open = new Set();            // session ids whose pane is showing
  const rows = new Map();            // session id -> Map(request id -> snapshot)
  const filters = new Map();         // session id -> filter text
  const expanded = new Map();        // session id -> request id shown in full
  const panes = new Map();           // session id -> the pane element, kept across re-renders
  // Fetched details, so a repaint (one every push, on a busy app) redraws what
  // is open instead of asking the app for it again.
  const details = new Map();         // "session|request" -> detail
  const loading = new Set();
  const listeners = [];

  const bucket = (id) => {
    let map = rows.get(id);
    if (!map) rows.set(id, (map = new Map()));
    return map;
  };

  // --- formatting ----------------------------------------------------------

  const duration = (ms) => (ms === undefined || ms === null ? '' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');

  const size = (bytes) => (bytes === undefined || bytes === null ? '' : humanSize(bytes));

  /** Path and query: the host is the same for every row of one app. */
  function shortUri(uri) {
    try {
      const parsed = new URL(uri);
      return parsed.pathname + parsed.search;
    } catch { return uri; }
  }

  function statusClass(r) {
    if (r.error) return 'bad';
    if (r.inProgress) return 'wait';
    if (!r.statusCode) return '';
    if (r.statusCode < 300) return 'ok';
    if (r.statusCode < 400) return 'redir';
    return 'bad';
  }

  const statusText = (r) => (r.error ? 'err' : r.inProgress ? '…' : r.statusCode || '?');

  /** First value of a header, case-insensitively -- the VM sends whatever the app set. */
  function header(headers, name) {
    for (const key of Object.keys(headers || {})) {
      if (key.toLowerCase() === name) return (headers[key] || [])[0];
    }
    return undefined;
  }

  // --- the pane ------------------------------------------------------------

  function paneFor(sessionId) {
    let pane = panes.get(sessionId);
    if (pane) return pane;

    pane = document.createElement('div');
    pane.className = 'net';

    const bar = document.createElement('div');
    bar.className = 'net-bar';

    const filter = document.createElement('input');
    filter.type = 'text';
    filter.placeholder = 'filter — method or path';
    filter.spellcheck = false;
    filter.value = filters.get(sessionId) || '';
    filter.oninput = () => { filters.set(sessionId, filter.value); paint(sessionId); };

    const clear = document.createElement('button');
    clear.textContent = 'Clear';
    clear.title = 'Forget these requests, here and inside the app';
    clear.onclick = async () => {
      try {
        await call('networkClear', { session: sessionId });
        bucket(sessionId).clear();
        expanded.delete(sessionId);
        for (const key of [...details.keys()]) {
          if (key.startsWith(sessionId + '|')) details.delete(key);
        }
        paint(sessionId);
      } catch (err) { toast(err.message, true); }
    };

    const count = document.createElement('span');
    count.className = 'net-count';

    bar.appendChild(filter);
    bar.appendChild(count);
    bar.appendChild(clear);

    const list = document.createElement('div');
    list.className = 'net-rows';

    pane.appendChild(bar);
    pane.appendChild(list);
    pane._list = list;
    pane._count = count;
    panes.set(sessionId, pane);
    return pane;
  }

  function matching(sessionId) {
    const all = [...bucket(sessionId).values()];
    const text = (filters.get(sessionId) || '').trim();
    if (!text) return all;
    let pattern;
    try { pattern = new RegExp(text, 'i'); } catch { return all; }
    return all.filter((r) => pattern.test(r.method + ' ' + r.uri));
  }

  /** Rebuild one pane's rows. Cheap enough at 500 rows, and always consistent. */
  function paint(sessionId) {
    const pane = panes.get(sessionId);
    if (!pane || !open.has(sessionId)) return;
    const visible = matching(sessionId);
    const total = bucket(sessionId).size;
    pane._count.textContent = visible.length === total
      ? total + ' requests'
      : visible.length + ' of ' + total;

    const list = pane._list;
    // Follow new traffic only while the reader is at the bottom and has nothing
    // open: yanking the list down while someone is reading one request in full
    // is how a row ends up clicked by accident.
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 40 && !expanded.has(sessionId);
    const wasAt = list.scrollTop;
    list.innerHTML = '';
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'net-empty';
      empty.textContent = total ? 'nothing matches that filter' : 'no requests captured yet';
      list.appendChild(empty);
      return;
    }

    for (const request of visible) {
      const row = document.createElement('div');
      row.className = 'net-row' + (expanded.get(sessionId) === request.id ? ' on' : '');
      row.innerHTML =
        '<span class="m">' + esc(request.method) + '</span>' +
        '<span class="s ' + statusClass(request) + '">' + esc(String(statusText(request))) + '</span>' +
        '<span class="d">' + esc(duration(request.durationMs)) + '</span>' +
        '<span class="z">' + esc(size(request.responseContentLength)) + '</span>' +
        '<span class="u" title="' + esc(request.uri) + '">' + esc(shortUri(request.uri)) + '</span>';
      row.onclick = () => toggleDetail(sessionId, request.id);
      list.appendChild(row);

      if (expanded.get(sessionId) === request.id) {
        const host = document.createElement('div');
        host.className = 'net-detail';
        list.appendChild(host);
        const cached = details.get(sessionId + '|' + request.id);
        if (cached) renderDetail(host, cached);
        else {
          host.textContent = 'Loading…';
          loadDetail(sessionId, request.id, host);
        }
      }
    }
    list.scrollTop = follow ? list.scrollHeight : wasAt;
  }

  function toggleDetail(sessionId, requestId) {
    if (expanded.get(sessionId) === requestId) expanded.delete(sessionId);
    else expanded.set(sessionId, requestId);
    paint(sessionId);
  }

  // --- one request, in full ------------------------------------------------

  async function loadDetail(sessionId, requestId, host) {
    const key = sessionId + '|' + requestId;
    if (loading.has(key)) return;
    loading.add(key);
    try {
      const detail = await call('networkDetail', { session: sessionId, id: requestId });
      details.set(key, detail);
      // The pane may have been repainted or closed while this was in flight.
      if (expanded.get(sessionId) === requestId) paint(sessionId);
    } catch (err) {
      host.textContent = err.message;
      host.classList.add('net-err');
    } finally {
      loading.delete(key);
    }
  }

  function renderDetail(host, detail) {
    host.textContent = '';
    host.classList.remove('net-err');

    const line = document.createElement('div');
    line.className = 'net-line';
    line.innerHTML =
      '<span class="s ' + statusClass(detail) + '">' + esc(String(statusText(detail))) + '</span>' +
      '<span>' + esc(detail.reasonPhrase || '') + '</span>' +
      '<span class="muted">' + esc(duration(detail.durationMs)) + '</span>' +
      '<span class="muted">' + esc(detail.uri) + '</span>';
    host.appendChild(line);

    const copy = document.createElement('button');
    copy.className = 'net-copy';
    copy.textContent = 'Copy as cURL';
    copy.onclick = (e) => {
      e.stopPropagation();
      const command = asCurl(detail);
      navigator.clipboard.writeText(command).then(
        () => toast('cURL copied'),
        () => toast('could not reach the clipboard', true),
      );
    };
    host.appendChild(copy);

    host.appendChild(headerTable('request headers', detail.requestHeaders));
    if (detail.responseHeaders) host.appendChild(headerTable('response headers', detail.responseHeaders));

    const requestType = header(detail.requestHeaders, 'content-type');
    if (detail.requestBody) host.appendChild(bodyBlock('request body', detail.requestBody, requestType));
    if (detail.responseBody) host.appendChild(bodyBlock('response body', detail.responseBody, detail.contentType));
  }

  function headerTable(label, headers) {
    const block = document.createElement('div');
    block.className = 'net-block';
    const names = Object.keys(headers || {}).sort();
    let html = '<div class="net-label">' + esc(label) + '</div>';
    if (!names.length) html += '<div class="muted">none</div>';
    for (const name of names) {
      for (const value of headers[name]) {
        html += '<div class="net-h"><span>' + esc(name) + ':</span>' + esc(value) + '</div>';
      }
    }
    block.innerHTML = html;
    return block;
  }

  function bodyBlock(label, body, contentType) {
    const block = document.createElement('div');
    block.className = 'net-block';
    const head = document.createElement('div');
    head.className = 'net-label';
    head.textContent = label + '  ·  ' + humanSize(body.size) + (body.truncated ? ', truncated' : '');
    block.appendChild(head);

    const pre = document.createElement('pre');
    if (body.text === undefined || body.text === null) {
      pre.className = 'muted';
      pre.textContent = '<binary, ' + body.size + ' bytes>';
    } else {
      pre.textContent = pretty(body.text, contentType);
    }
    block.appendChild(pre);
    return block;
  }

  /** Indent JSON when the response says it is JSON; leave anything else alone. */
  function pretty(text, contentType) {
    if (!/json/i.test(contentType || '')) return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  /**
   * The request as a shell command.
   *
   * Single-quoted with `'\''` for embedded quotes: the one escaping rule that
   * holds for every byte a URI, header or JSON body can contain.
   */
  function asCurl(detail) {
    const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
    const parts = ['curl -X ' + detail.method + ' ' + quote(detail.uri)];
    for (const name of Object.keys(detail.requestHeaders || {})) {
      for (const value of detail.requestHeaders[name]) {
        parts.push('  -H ' + quote(name + ': ' + value));
      }
    }
    const body = detail.requestBody;
    if (body && body.text) parts.push('  --data ' + quote(body.text));
    return parts.join(' \\\n');
  }

  // --- wiring into the HUD -------------------------------------------------

  async function toggle(sessionId) {
    if (open.has(sessionId)) {
      open.delete(sessionId);
      const pane = panes.get(sessionId);
      if (pane) pane.classList.remove('open');
      return;
    }
    open.add(sessionId);
    const pane = panes.get(sessionId);
    if (pane) pane.classList.add('open');
    try {
      const captured = await call('network', { session: sessionId, tail: CAP });
      const map = bucket(sessionId);
      for (const request of captured) map.set(request.id, request);
    } catch (err) {
      toast(err.message, true);
    }
    paint(sessionId);
  }

  extend({
    row(session, ctx) {
      const can = session.capabilities.indexOf('network') !== -1;
      const make = ctx.iconButton || ctx.button;
      const button = make(
        ctx.iconButton ? 'network' : '⇅',
        can ? COVERAGE : 'Enable batonTrace on a Node target, or run a Flutter debug session',
        can,
        () => toggle(session.id),
      );
      ctx.top.appendChild(button);
      if (!can) return;

      const pane = paneFor(session.id);
      pane.classList.toggle('open', open.has(session.id));
      ctx.row.appendChild(pane);
      // The row was just rebuilt from scratch, so its contents have to be too.
      if (open.has(session.id)) queueMicrotask(() => paint(session.id));
    },

    event(msg) {
      if (msg.event === 'network') {
        const map = bucket(msg.sessionId);
        // Set on an existing key keeps its position, so an in-flight request
        // that finishes updates its row instead of jumping to the bottom.
        map.set(msg.request.id, msg.request);
        // An in-flight request that just finished has a different detail now.
        details.delete(msg.sessionId + '|' + msg.request.id);
        while (map.size > CAP) map.delete(map.keys().next().value);
        if (open.has(msg.sessionId)) paint(msg.sessionId);
        for (const fn of listeners) {
          try { fn(msg.sessionId); } catch (err) { console.error(err); }
        }
      }
    },
  });

  window.baton.network = {
    list(sessionId) { return [...bucket(sessionId).values()]; },
    async pull(sessionId) {
      const captured = await call('network', { session: sessionId, tail: CAP });
      const map = bucket(sessionId);
      for (const request of captured) map.set(request.id, request);
      return [...map.values()];
    },
    async detail(sessionId, requestId) {
      const key = sessionId + '|' + requestId;
      if (details.has(key)) return details.get(key);
      const detail = await call('networkDetail', { session: sessionId, id: requestId });
      details.set(key, detail);
      return detail;
    },
    async clear(sessionId) {
      await call('networkClear', { session: sessionId });
      bucket(sessionId).clear();
      expanded.delete(sessionId);
      for (const key of [...details.keys()]) {
        if (key.startsWith(sessionId + '|')) details.delete(key);
      }
      if (open.has(sessionId)) paint(sessionId);
    },
    asCurl, pretty, statusClass, statusText, duration, size, shortUri,
    coverage: COVERAGE,
    onUpdate(fn) { listeners.push(fn); },
  };
})();
