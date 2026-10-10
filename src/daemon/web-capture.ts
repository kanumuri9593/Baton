import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

/** A page size, plus whether it should behave like a phone or tablet. */
export type WebViewport = { width: number; height: number; mobile: boolean; scale: number };

/** What the page itself reported while it loaded: the evidence a terminal never sees. */
export type WebEvidence = {
  /** Uncaught exceptions, console.error calls and browser-logged errors, in order. */
  consoleErrors: string[];
  /** Requests the page made that failed or answered 4xx/5xx: `GET 404 http://…`. */
  failedRequests: string[];
};

/** Writes a PNG of `url` at `viewport` to `path`, and reports what went wrong on the page. Injectable for tests. */
export type WebCaptureFn = (
  browser: string, url: string, viewport: WebViewport, path: string,
) => Promise<WebEvidence | void>;

const MAX_EVIDENCE = 20;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/18.0 Mobile/15E148 Safari/604.1';

const LAUNCH_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 20_000;
/** After `load`: long enough for client-side rendering, fonts and entry animations to settle. */
const SETTLE_MS = 1_200;

/**
 * Capture a page in a throwaway headless browser over the DevTools protocol.
 *
 * Chrome's own `--screenshot` flag cannot do this job: it enforces a 500px
 * minimum window width, so a "phone" capture is really a cropped tablet. Device
 * metrics emulation gives a true phone layout (mobile viewport, touch-sized
 * device pixel ratio, phone user agent), and a fresh profile directory keeps
 * the user's own browser and its tabs out of it.
 */
export const captureWithDevTools: WebCaptureFn = async (browser, url, viewport, path) => {
  const profile = mkdtempSync(join(tmpdir(), 'baton-shot-'));
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    // Chrome refuses to start as root without this, and containers (where
    // cloud agents run) are usually root.
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  try {
    const port = await devToolsPort(child);
    const pageWs = await firstPage(port);
    const cdp = await connect(pageWs);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.mobile,
      });
      if (viewport.mobile) {
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      }
      const evidence: WebEvidence = { consoleErrors: [], failedRequests: [] };
      const note = (list: string[], line: string) => {
        if (line && list.length < MAX_EVIDENCE) list.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
      };
      const requests = new Map<string, { method: string; url: string }>();
      cdp.on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails ?? {};
        note(evidence.consoleErrors, d.exception?.description ?? d.text ?? 'uncaught exception');
      });
      cdp.on('Runtime.consoleAPICalled', (p) => {
        if (p.type !== 'error' && p.type !== 'assert') return;
        note(evidence.consoleErrors, (p.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').trim());
      });
      cdp.on('Log.entryAdded', (p) => {
        // Failed requests already arrive through the network events below.
        if (p.entry?.level === 'error' && p.entry.source !== 'network') note(evidence.consoleErrors, p.entry.text);
      });
      cdp.on('Network.requestWillBeSent', (p) => {
        requests.set(p.requestId, { method: p.request?.method ?? 'GET', url: p.request?.url ?? '' });
      });
      cdp.on('Network.responseReceived', (p) => {
        const status = p.response?.status ?? 0;
        // Browsers ask for /favicon.ico on their own; a missing one is not the app's failure.
        if (status >= 400 && !/\/favicon\.ico(\?|$)/.test(p.response.url)) note(evidence.failedRequests, `${requests.get(p.requestId)?.method ?? 'GET'} ${status} ${p.response.url}`);
      });
      cdp.on('Network.loadingFailed', (p) => {
        if (p.canceled) return;
        const r = requests.get(p.requestId);
        note(evidence.failedRequests, `${r?.method ?? 'GET'} ERR ${r?.url ?? ''}  ${p.errorText ?? 'failed'}`);
      });
      await cdp.send('Runtime.enable', {});
      await cdp.send('Log.enable', {});
      await cdp.send('Network.enable', {});
      await cdp.send('Page.enable', {});
      const loaded = cdp.once('Page.loadEventFired', LOAD_TIMEOUT_MS);
      const nav = await cdp.send('Page.navigate', { url });
      if (nav.errorText) throw new Error(`could not open ${url}: ${nav.errorText}`);
      await loaded.catch(() => undefined); // a page that never fires load is still worth a look
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      return evidence;
    } finally {
      cdp.close();
    }
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(undefined);
      child.once('exit', resolve);
      setTimeout(resolve, 2_000).unref();
    });
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
};

/** Chrome prints `DevTools listening on ws://127.0.0.1:<port>/...` to stderr once it is up. */
function devToolsPort(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`headless browser did not start within ${LAUNCH_TIMEOUT_MS}ms: ${stderr.trim().slice(-300)}`));
    }, LAUNCH_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`headless browser exited (${code}) before it was ready: ${stderr.trim().slice(-300)}`));
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(stderr);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
}

async function firstPage(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json() as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('headless browser opened no page');
  return page.webSocketDebuggerUrl;
}

type Cdp = {
  send(method: string, params: Record<string, unknown>): Promise<any>;
  on(event: string, listener: (params: any) => void): void;
  once(event: string, timeoutMs: number): Promise<any>;
  close(): void;
};

/** The smallest DevTools protocol client that does the job: request/response plus one-shot events. */
function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const waiters = new Map<string, (params: any) => void>();
    const listeners = new Map<string, ((params: any) => void)[]>();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && pending.has(message.id)) {
        const p = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message));
        else p.resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners.get(message.method) ?? []) listener(message.params);
        const waiter = waiters.get(message.method);
        if (waiter) { waiters.delete(message.method); waiter(message.params); }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      for (const p of pending.values()) p.reject(new Error('browser connection closed'));
    });
    socket.on('open', () => resolve({
      send: (method, params) => new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        socket.send(JSON.stringify({ id, method, params }));
      }),
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      once: (event, timeoutMs) => new Promise((res, rej) => {
        const timer = setTimeout(() => { waiters.delete(event); rej(new Error(`${event} timed out`)); }, timeoutMs);
        waiters.set(event, (params) => { clearTimeout(timer); res(params); });
      }),
      close: () => socket.close(),
    }));
  });
}
