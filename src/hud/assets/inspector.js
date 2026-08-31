/**
 * Right-pane inspector — Logs and Network, with the filters a working
 * session actually needs.
 *
 * Compact inline panes stay on the session row. This file is the readable
 * view: chips, a split request/response, copy actions. Filter predicates live
 * in filters.js so the tests and this page cannot drift apart.
 */
import { matchLog, matchNetwork } from '/assets/filters.js';

(function () {
  const {
    call, toast, esc, humanSize, iconButton, extend, hydrateLogs, logBuffer, setDensity,
    loadSplits, saveSplits, clampInspectorWidth, clampDetailWidth, wireGutter,
  } = window.baton;

  const insp = document.getElementById('inspector');
  if (!insp) return;

  const net = () => window.baton.network;

  let tab = 'logs'; // 'logs' | 'network'
  let sessionId = null;
  let logFilter = { level: 'all', text: '' };
  let netFilter = { status: 'all', methods: [], hideNoise: false, text: '' };
  let selectedRequest = null;
  let detailTab = 'headers'; // 'headers' | 'request' | 'response' | 'error'
  let detailCache = null;
  const pulled = new Set();
  const splits = loadSplits();

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const chip = (label, on, onClick, title) => {
    const b = el('button', 'insp-chip' + (on ? ' on' : ''), label);
    if (title) b.title = title;
    b.onclick = onClick;
    return b;
  };

  function selectedSession() {
    const id = window.baton.activeSession && window.baton.activeSession();
    if (id) return id;
    const live = (window.baton.sessions ? window.baton.sessions() : []).filter(
      (s) => s.status === 'running' || s.status === 'starting',
    );
    return live[0] ? live[0].id : null;
  }

  function mount() {
    insp.textContent = '';
    const head = el('div', 'insp-head');
    const tabs = el('div', 'insp-tabs');
    tabs.appendChild(chip('Logs', tab === 'logs', () => { tab = 'logs'; paint(); }));
    tabs.appendChild(chip('Network', tab === 'network', () => { tab = 'network'; paint(); }));
    head.appendChild(tabs);
    head.appendChild(el('span', 'spacer'));
    head.appendChild(iconButton('minimize', 'Minimize to chip', true, () => setDensity('chip', true)));
    insp.appendChild(head);

    const bar = el('div', 'insp-bar');
    insp.appendChild(bar);
    insp._bar = bar;

    const body = el('div', 'insp-body');
    insp.appendChild(body);
    insp._body = body;
  }

  function paintFilters() {
    const bar = insp._bar;
    bar.textContent = '';
    if (tab === 'logs') {
      bar.appendChild(chip('All', logFilter.level === 'all', () => { logFilter.level = 'all'; paint(); }));
      bar.appendChild(chip('Errors', logFilter.level === 'errors', () => { logFilter.level = 'errors'; paint(); }, 'Only lines the session marked as errors'));
      bar.appendChild(chip('Not errors', logFilter.level === 'ok', () => { logFilter.level = 'ok'; paint(); }));
      const search = document.createElement('input');
      search.type = 'text';
      search.placeholder = 'filter logs';
      search.spellcheck = false;
      search.value = logFilter.text;
      search.oninput = () => { logFilter.text = search.value; paint(); };
      bar.appendChild(search);
      return;
    }

    bar.appendChild(chip('All', netFilter.status === 'all', () => { netFilter.status = 'all'; paint(); }));
    bar.appendChild(chip('OK', netFilter.status === 'ok', () => { netFilter.status = 'ok'; paint(); }, '2xx'));
    bar.appendChild(chip('Redirects', netFilter.status === 'redirects', () => { netFilter.status = 'redirects'; paint(); }, '3xx'));
    const err = chip('Errors', netFilter.status === 'errors', () => { netFilter.status = 'errors'; paint(); }, '4xx, 5xx, or transport failure');
    err.prepend(window.baton.iconEl('warning'));
    bar.appendChild(err);
    bar.appendChild(chip('In flight', netFilter.status === 'inflight', () => { netFilter.status = 'inflight'; paint(); }));

    for (const method of ['GET', 'POST', 'PUT/PATCH', 'DELETE']) {
      const on = netFilter.methods.includes(method);
      bar.appendChild(chip(method, on, () => {
        netFilter.methods = on
          ? netFilter.methods.filter((m) => m !== method)
          : netFilter.methods.concat(method);
        paint();
      }));
    }
    bar.appendChild(chip(
      'Hide noise',
      netFilter.hideNoise,
      () => { netFilter.hideNoise = !netFilter.hideNoise; paint(); },
      'Hide images, fonts and analytics',
    ));

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'method, host or path';
    search.spellcheck = false;
    search.value = netFilter.text;
    search.oninput = () => { netFilter.text = search.value; paint(); };
    bar.appendChild(search);

    const clear = iconButton('clear', 'Forget these requests', true, async () => {
      if (!sessionId || !net()) return;
      try {
        await net().clear(sessionId);
        selectedRequest = null;
        detailCache = null;
        paint();
      } catch (err) { toast(err.message, true); }
    });
    bar.appendChild(clear);
  }

  function paintLogs() {
    const body = insp._body;
    body.className = 'insp-body';
    body.textContent = '';
    if (!sessionId) {
      body.appendChild(el('div', 'insp-empty', 'Nothing running — pick a target and press Run.'));
      return;
    }
    const lines = (logBuffer(sessionId) || []).filter((line) => matchLog(line, logFilter));
    if (!lines.length) {
      const why = logFilter.level === 'errors' ? 'no errors in this window'
        : (logFilter.text ? 'nothing matches that filter' : 'no log lines yet');
      body.appendChild(el('div', 'insp-empty', why));
      return;
    }
    const pane = el('div', 'insp-logs');
    for (const line of lines) {
      const row = el('div', line.error ? 'err' : '');
      row.textContent = line.text;
      pane.appendChild(row);
    }
    body.appendChild(pane);
    queueMicrotask(() => { pane.scrollTop = pane.scrollHeight; });
  }

  function paintNetwork() {
    const body = insp._body;
    body.className = 'insp-body insp-net';
    body.textContent = '';
    if (!sessionId) {
      body.appendChild(el('div', 'insp-empty', 'Nothing running — pick a target and press Run.'));
      return;
    }
    if (!net()) {
      body.appendChild(el('div', 'insp-empty', 'Network inspector is not loaded.'));
      return;
    }

    const all = net().list(sessionId);
    if (!pulled.has(sessionId) && net().pull) {
      pulled.add(sessionId);
      net().pull(sessionId).then(() => paint()).catch((err) => toast(err.message, true));
    }
    const visible = all.filter((row) => matchNetwork(row, netFilter));
    const list = el('div', 'insp-rows');
    if (!visible.length) {
      const why = all.length ? 'nothing matches that filter' : 'no requests captured yet';
      list.appendChild(el('div', 'insp-empty', why));
    } else {
      for (const request of visible) {
        const row = el('div', 'net-row' + (selectedRequest === request.id ? ' on' : ''));
        row.innerHTML =
          '<span class="m">' + esc(request.method) + '</span>' +
          '<span class="s ' + net().statusClass(request) + '">' + esc(String(net().statusText(request))) + '</span>' +
          '<span class="d">' + esc(net().duration(request.durationMs)) + '</span>' +
          '<span class="z">' + esc(net().size(request.responseContentLength)) + '</span>' +
          '<span class="u" title="' + esc(request.uri) + '">' + esc(net().shortUri(request.uri)) + '</span>';
        row.onclick = () => {
          selectedRequest = selectedRequest === request.id ? null : request.id;
          detailCache = null;
          detailTab = 'headers';
          paint();
        };
        list.appendChild(row);
      }
    }

    const detail = el('div', 'insp-detail');
    if (!selectedRequest) {
      detail.appendChild(el('div', 'insp-empty', 'Click a request to see headers, body and errors.'));
    } else {
      renderDetail(detail, selectedRequest);
    }
    const gutter = el('div', 'gutter');
    gutter.title = 'Resize request detail';
    gutter.setAttribute('role', 'separator');
    gutter.setAttribute('aria-orientation', 'vertical');
    body.appendChild(list);
    body.appendChild(gutter);
    body.appendChild(detail);
    applyInner(body);
    wireGutter(gutter, (delta) => {
      document.body.classList.add('splitting');
      const current = parsePx(body.style.getPropertyValue('--detail-w'))
        || clampDetailWidth(body.clientWidth, splits.detail);
      splits.detail = clampDetailWidth(body.clientWidth, current + delta);
      applyInner(body);
    }, persistSplits);
  }

  function parsePx(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  function persistSplits() {
    document.body.classList.remove('splitting');
    saveSplits(splits);
  }

  function applyOuter() {
    if (document.body.dataset.density !== 'inspector') return;
    const width = clampInspectorWidth(document.body.clientWidth, splits.inspector);
    document.body.style.setProperty('--insp-w', width + 'px');
  }

  function applyInner(body) {
    const width = clampDetailWidth(body.clientWidth, splits.detail);
    body.style.setProperty('--detail-w', width + 'px');
  }

  function renderDetail(host, requestId) {
    const snapshot = net().list(sessionId).find((r) => r.id === requestId);
    if (!snapshot) {
      host.appendChild(el('div', 'insp-empty', 'That request is no longer in the captured window.'));
      return;
    }

    const tabs = el('div', 'insp-tabs');
    const failed = Boolean(snapshot.error) || (snapshot.statusCode !== undefined && snapshot.statusCode >= 400);
    const names = ['headers', 'request', 'response'];
    if (failed) names.push('error');
    if (detailTab === 'error' && !failed) detailTab = 'headers';
    for (const name of names) {
      tabs.appendChild(chip(labelFor(name), detailTab === name, () => { detailTab = name; paint(); }));
    }
    host.appendChild(tabs);

    const actions = el('div', 'insp-actions');
    actions.appendChild(copyBtn('Copy as cURL', async () => {
      const detail = await ensureDetail(requestId);
      if (!detail) return;
      await copy(net().asCurl(detail), 'cURL copied');
    }));
    actions.appendChild(copyBtn('Copy URL', () => copy(snapshot.uri, 'URL copied')));
    actions.appendChild(copyBtn('Copy body', async () => {
      const detail = await ensureDetail(requestId);
      if (!detail) return;
      const body = detailTab === 'request' ? detail.requestBody : detail.responseBody;
      if (!body || body.text === undefined || body.text === null) return toast('no text body to copy', true);
      await copy(net().pretty(body.text, detailTab === 'request'
        ? header(detail.requestHeaders, 'content-type')
        : detail.contentType), 'body copied');
    }));
    host.appendChild(actions);

    const pane = el('div', 'insp-detail-body');
    host.appendChild(pane);
    if (detailCache && detailCache.id === requestId) fillDetail(pane, detailCache, snapshot);
    else {
      pane.textContent = 'Loading…';
      ensureDetail(requestId).then((detail) => {
        if (selectedRequest !== requestId) return;
        pane.textContent = '';
        fillDetail(pane, detail, snapshot);
      }).catch((err) => {
        pane.textContent = err.message;
        pane.classList.add('net-err');
      });
    }
  }

  function labelFor(name) {
    if (name === 'headers') return 'Headers';
    if (name === 'request') return 'Request';
    if (name === 'response') return 'Response';
    return 'Error';
  }

  function copyBtn(label, onClick) {
    const b = el('button', 'net-copy', label);
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
  }

  async function copy(text, ok) {
    try {
      await navigator.clipboard.writeText(text);
      toast(ok);
    } catch {
      toast('could not reach the clipboard', true);
    }
  }

  async function ensureDetail(requestId) {
    if (detailCache && detailCache.id === requestId) return detailCache;
    const detail = await net().detail(sessionId, requestId);
    detailCache = detail;
    return detail;
  }

  function header(headers, name) {
    for (const key of Object.keys(headers || {})) {
      if (key.toLowerCase() === name) return (headers[key] || [])[0];
    }
    return undefined;
  }

  function fillDetail(pane, detail, snapshot) {
    if (detailTab === 'error') {
      pane.appendChild(el('div', 'net-err', snapshot.error || ('HTTP ' + (snapshot.statusCode || '?'))));
      if (detail.reasonPhrase) pane.appendChild(el('div', 'muted', detail.reasonPhrase));
      pane.appendChild(el('div', 'muted', snapshot.uri));
      return;
    }
    if (detailTab === 'headers') {
      pane.appendChild(headerTable('request headers', detail.requestHeaders));
      pane.appendChild(headerTable('response headers', detail.responseHeaders));
      return;
    }
    const body = detailTab === 'request' ? detail.requestBody : detail.responseBody;
    const type = detailTab === 'request' ? header(detail.requestHeaders, 'content-type') : detail.contentType;
    if (!body) {
      pane.appendChild(el('div', 'insp-empty', 'no ' + detailTab + ' body'));
      return;
    }
    const pre = el('pre');
    if (body.text === undefined || body.text === null) {
      pre.className = 'muted';
      pre.textContent = '<binary, ' + body.size + ' bytes>';
    } else {
      pre.textContent = net().pretty(body.text, type);
    }
    const label = el('div', 'net-label', detailTab + ' body  ·  ' + humanSize(body.size) + (body.truncated ? ', truncated' : ''));
    pane.appendChild(label);
    pane.appendChild(pre);
  }

  function headerTable(label, headers) {
    const block = el('div', 'net-block');
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

  function paint() {
    sessionId = selectedSession();
    paintFilters();
    if (tab === 'logs') paintLogs();
    else paintNetwork();
  }

  mount();

  extend({
    event(msg) {
      if (document.body.dataset.density !== 'inspector') return;
      if (document.body.classList.contains('splitting')) return;
      if (msg.event === 'log' && tab === 'logs' && msg.sessionId === sessionId) paintLogs();
      if (msg.event === 'network' && tab === 'network' && msg.sessionId === sessionId) {
        if (selectedRequest === msg.request.id) detailCache = null;
        paintNetwork();
      }
      if (msg.event === 'session' || msg.event === 'hello') paint();
    },
    sessionFocus() { paint(); },
    density(name) {
      if (name === 'inspector') applyOuter();
      if (name !== 'inspector') return;
      const id = selectedSession();
      if (id && hydrateLogs) hydrateLogs(id).then(() => paint());
      else paint();
    },
  });

  if (net() && net().onUpdate) {
    net().onUpdate((id) => {
      if (document.body.dataset.density !== 'inspector') return;
      if (document.body.classList.contains('splitting')) return;
      if (tab === 'network' && id === sessionId) paintNetwork();
    });
  }

  const outer = document.getElementById('splitOuter');
  if (outer) {
    wireGutter(outer, (delta) => {
      document.body.classList.add('splitting');
      const current = parsePx(document.body.style.getPropertyValue('--insp-w'))
        || clampInspectorWidth(document.body.clientWidth, splits.inspector);
      splits.inspector = clampInspectorWidth(document.body.clientWidth, current + delta);
      applyOuter();
    }, persistSplits);
  }
  addEventListener('resize', applyOuter);
  applyOuter();

  if (document.body.dataset.density === 'inspector') {
    const id = selectedSession();
    if (id && hydrateLogs) hydrateLogs(id).then(() => paint());
    else paint();
  } else {
    paint();
  }
})();
