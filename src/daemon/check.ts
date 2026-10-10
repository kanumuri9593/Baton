import type { LogLine, NetworkRequestSnapshot, OperationResult, Session, SessionStatus } from '../core/types.ts';

/** What applying a change to a running session means. `auto` picks per session kind. */
export type CheckAction = 'auto' | 'reload' | 'restart' | 'none';

export type CheckParams = {
  session: string;
  action?: CheckAction;
  /** Milliseconds to let the app settle after the action, before collecting evidence. Default 1500. */
  settleMs?: number;
  /** Take a screenshot. Default true. */
  screenshot?: boolean;
  /** Web captures only: `phone`, `tablet`, `desktop` or `WIDTHxHEIGHT`. */
  viewport?: string;
  out?: string;
};

export type CheckResult = {
  session: string;
  action: Exclude<CheckAction, 'auto'>;
  /** True when the action worked, the session is running, and nothing new went wrong. */
  ok: boolean;
  status: SessionStatus;
  operation?: OperationResult & { errors?: string[] };
  /** Error-looking log lines written since the check started, newest last. */
  newErrors: string[];
  /** Captured requests since the check started that failed or returned 4xx/5xx. */
  failedRequests: string[];
  screenshotPath?: string;
  screenshotError?: string;
  elapsedMs: number;
};

/** The daemon machinery a check needs. Injectable so tests need no real app. */
export type CheckHost = {
  apply(session: Session, action: 'reload' | 'restart'): Promise<OperationResult & { errors?: string[] }>;
  waitReady(session: Session, timeoutMs: number): Promise<void>;
  network(session: Session, since: number): NetworkRequestSnapshot[];
  /** The PNG path, plus what a web page reported while it loaded. */
  screenshot(session: Session, opts: { out?: string; viewport?: string }): Promise<{
    path: string; consoleErrors?: string[]; failedRequests?: string[];
  }>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

/** Lines a person would read as an error, even when the tool printed them to stdout. */
const ERRORISH = /\b(error|exception|failed to compile|uncaught|unhandled|fatal)\b/i;
const MAX_ERRORS = 20;

/**
 * Pick what applying a change means when the agent did not say.
 *
 * Flutter hot reloads, keeping state. Web dev servers and React Native already
 * applied the edit through HMR / Fast Refresh, so touching them would only lose
 * state. Everything else (native builds, plain processes) has to restart.
 */
export function chooseAction(session: Session, requested: CheckAction = 'auto'): Exclude<CheckAction, 'auto'> {
  if (requested !== 'auto') return requested;
  if (session.capabilities.has('hotReload')) return 'reload';
  if (session.kind === 'web-dev' || session.kind === 'react-native') return 'none';
  return 'restart';
}

/** Error-looking lines logged at or after `since`, capped and newest last. */
export function errorsSince(lines: LogLine[], since: number): string[] {
  return lines
    .filter((l) => l.at >= since && (l.error || ERRORISH.test(l.text)))
    .map((l) => l.text.trim())
    .filter(Boolean)
    .slice(-MAX_ERRORS);
}

/** `GET 500 https://…` for every request that errored or answered 4xx/5xx. */
export function failedSince(requests: NetworkRequestSnapshot[]): string[] {
  return requests
    .filter((r) => r.error || (r.statusCode !== undefined && r.statusCode >= 400))
    .map((r) => `${r.method} ${r.error ? 'ERR' : r.statusCode} ${r.uri}${r.error ? `  ${r.error}` : ''}`)
    .slice(-MAX_ERRORS);
}

/**
 * Apply a change and gather the evidence an agent needs to judge it, in one call.
 *
 * The usual loop is reload, wait, read logs, list requests, screenshot: five
 * round trips per edit. This does them in order and answers with only what
 * changed since the check began, so an agent sees its own breakage rather
 * than old noise.
 */
export async function checkChange(session: Session, params: CheckParams, host: CheckHost): Promise<CheckResult> {
  const started = host.now();
  const action = chooseAction(session, params.action);
  let operation: CheckResult['operation'];

  if (action !== 'none') {
    operation = await host.apply(session, action);
    if (action === 'restart' && operation.code === 0) {
      await host.waitReady(session, 120_000).catch(() => undefined);
    }
  }

  const settleMs = params.settleMs ?? 1500;
  if (settleMs > 0) await host.sleep(settleMs);

  const status = session.status;

  // Screenshot before reading logs: for a web app, loading the page is what
  // makes the dev server compile the edited module, so its errors land now.
  // The page also reports what the terminal never sees: a syntax error in a
  // module, an uncaught exception, a 404 for an asset.
  let screenshotPath: string | undefined;
  let screenshotError: string | undefined;
  let browser: { consoleErrors?: string[]; failedRequests?: string[] } = {};
  if (params.screenshot !== false && status === 'running') {
    try {
      const shot = await host.screenshot(session, { out: params.out, viewport: params.viewport });
      screenshotPath = shot.path;
      browser = shot;
    } catch (err) {
      screenshotError = (err as Error).message;
    }
  }

  const newErrors = [
    ...errorsSince(session.recentLogs(500), started),
    ...(browser.consoleErrors ?? []).map((e) => `[browser] ${e}`),
  ].slice(-MAX_ERRORS);
  const failedRequests = [
    ...failedSince(host.network(session, started)),
    ...(browser.failedRequests ?? []).map((r) => `[browser] ${r}`),
  ].slice(-MAX_ERRORS);

  const ok = (operation?.code ?? 0) === 0 && status === 'running' && newErrors.length === 0 && failedRequests.length === 0;
  return {
    session: session.id,
    action,
    ok,
    status,
    operation,
    newErrors,
    failedRequests,
    screenshotPath,
    screenshotError,
    elapsedMs: host.now() - started,
  };
}
