import type { EventEmitter } from 'node:events';
import type { Session, SessionStatus } from '../core/types.ts';

/** What `wait` can be asked to block on. */
export type WaitUntil = 'running' | 'stopped' | 'url' | { log: string };

export type WaitResult = {
  met: true;
  status: SessionStatus;
  elapsedMs: number;
  url?: string;
  matchedLine?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/** Applies the RPC's default and cap, so a caller cannot block the daemon forever. */
export function clampTimeout(timeoutMs?: number): number {
  const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(ms, MAX_TIMEOUT_MS);
}

/** What a session's `on`/`removeListener` need to look like -- every real `Session` qualifies. */
export type WaitableSession = Session &
  Pick<EventEmitter, 'on' | 'removeListener'> & { recentLogs: (limit?: number) => { text: string; error: boolean }[] };

function describe(until: WaitUntil): string {
  return typeof until === 'string' ? until : `log:${until.log}`;
}

/**
 * Block until a session reaches a state, instead of an agent polling `read_logs`.
 *
 * Subscribes to the session's own `change`/`log`/`exit` events rather than
 * polling: a hot reload or a compile failure needs to be seen the moment it
 * happens, not up to a poll interval later. Listeners are removed on every exit
 * path -- resolve, reject, or timeout -- so a session that outlives the wait
 * never accumulates them.
 */
export function waitForSession(
  session: WaitableSession,
  until: WaitUntil,
  timeoutMs?: number,
  recentErrors: (session: WaitableSession) => string[] = () => [],
): Promise<WaitResult> {
  // A malformed `until` (off the wire, unvalidated JSON) must be refused up
  // front -- an object with no string `log`, for instance, would otherwise
  // build `new RegExp(undefined)`, which matches every line rather than none.
  const validShape =
    until === 'running' || until === 'stopped' || until === 'url' ||
    (typeof until === 'object' && until !== null && typeof until.log === 'string');
  if (!validShape) {
    throw new Error(`invalid wait condition: ${JSON.stringify(until)}`);
  }

  const ms = clampTimeout(timeoutMs);
  const start = Date.now();
  const label = describe(until);

  return new Promise<WaitResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let logPattern: RegExp | undefined;

    if (typeof until === 'object') {
      try {
        logPattern = new RegExp(until.log, 'i');
      } catch (err) {
        reject(new Error(`invalid log pattern "${until.log}": ${(err as Error).message}`));
        return;
      }
    }

    const cleanup = () => {
      session.removeListener('change', onChange);
      session.removeListener('log', onLog);
      session.removeListener('exit', onChange);
      if (timer) clearTimeout(timer);
    };

    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeeded = (): boolean => {
      if (until === 'running') return session.status === 'running';
      if (until === 'stopped') return session.status === 'stopped' || session.status === 'failed';
      if (until === 'url') return Boolean(session.snapshot().url);
      return false; // 'log' is resolved from onLog only, never from a status check
    };

    const check = (): boolean => {
      if (succeeded()) {
        const result: WaitResult = { met: true, status: session.status, elapsedMs: Date.now() - start };
        if (until === 'url') result.url = session.snapshot().url;
        finish(result);
        return true;
      }
      // A terminal state that can never satisfy the condition -- e.g. 'running'
      // requested but the session just failed -- is worth failing immediately
      // rather than waiting out the full timeout to say the same thing.
      const terminal = session.status === 'stopped' || session.status === 'failed';
      if (terminal && until !== 'stopped') {
        const errors = recentErrors(session);
        fail(
          new Error(
            `cannot reach "${label}": session is ${session.status}` +
              (errors.length ? `\n${errors.join('\n')}` : ''),
          ),
        );
        return true;
      }
      return false;
    };

    const onChange = () => check();
    const onLog = (text: string) => {
      if (logPattern?.test(text)) {
        finish({ met: true, status: session.status, elapsedMs: Date.now() - start, matchedLine: text });
      }
    };

    // The condition may already hold -- e.g. a session that is already running
    // when `wait until: running` is called.
    if (check()) return;

    session.on('change', onChange);
    session.on('log', onLog);
    session.on('exit', onChange);

    timer = setTimeout(() => {
      fail(new Error(`timeout after ${ms}ms waiting for ${label}; status is ${session.status}`));
    }, ms);
    timer.unref?.();
  });
}
