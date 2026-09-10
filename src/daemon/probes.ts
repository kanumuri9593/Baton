import { createConnection } from 'node:net';

/**
 * A readiness check that can be made from outside a process.
 *
 * Log matching is deliberately not here: it needs a session's output stream,
 * which a remote endpoint or a container Baton did not start does not have.
 * These two are the checks that work for anything with an address.
 */
export type NetProbe = { tcp: number } | { http: string; status?: number };

export type ProbeResult = { ok: boolean; detail?: string };

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_INTERVAL_MS = 250;

export function isProbe(value: unknown): value is NetProbe {
  if (typeof value !== 'object' || value === null) return false;
  const probe = value as Record<string, unknown>;
  if (typeof probe.tcp === 'number') return Number.isInteger(probe.tcp) && probe.tcp > 0 && probe.tcp <= 65535;
  if (typeof probe.http === 'string') return probe.http.length > 0;
  return false;
}

/** How the probe reads in an error message or a status line. */
export function describeProbe(probe: NetProbe): string {
  if ('tcp' in probe) return `tcp:${probe.tcp}`;
  return probe.status ? `http:${probe.http} (${probe.status})` : `http:${probe.http}`;
}

/**
 * One attempt. Never throws: an unreachable service is the expected answer
 * while something is still starting, not an exceptional condition.
 */
export async function probeOnce(probe: NetProbe, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if ('tcp' in probe) return tcpProbe(probe.tcp, timeoutMs);
  try {
    const response = await fetch(probe.http, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    // Without an expected status, *any* HTTP answer means something is
    // listening and speaking HTTP -- a 404 from a server that is up is still
    // proof that it is up.
    if (probe.status === undefined) return { ok: true, detail: `HTTP ${response.status}` };
    return probe.status === response.status
      ? { ok: true, detail: `HTTP ${response.status}` }
      : { ok: false, detail: `HTTP ${response.status}, expected ${probe.status}` };
  } catch (error) {
    return { ok: false, detail: causeOf(error) };
  }
}

function tcpProbe(port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (result: ProbeResult) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => settle({ ok: false, detail: 'connection timed out' }));
    socket.once('connect', () => settle({ ok: true }));
    socket.once('error', (error) => settle({ ok: false, detail: causeOf(error) }));
  });
}

function causeOf(error: unknown): string {
  const code = (error as { code?: string; cause?: { code?: string } }).code
    ?? (error as { cause?: { code?: string } }).cause?.code;
  return code ?? (error as Error).message ?? String(error);
}

export type PollOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  /** Cancels the poll -- the waiter aborts it when the session dies first. */
  signal?: AbortSignal;
  /** Injected in tests and by the engine's fake host. */
  probeFn?: (probe: NetProbe) => Promise<ProbeResult>;
};

export class ProbeAborted extends Error {
  constructor() {
    super('probe cancelled');
    this.name = 'ProbeAborted';
  }
}

/**
 * Keep probing until it answers, or until the deadline.
 *
 * The rejection carries the last thing the probe actually saw (`ECONNREFUSED`,
 * `HTTP 500, expected 200`), because "timed out" alone never tells anyone
 * whether the service is missing, crashed, or merely slow.
 */
export async function pollProbe(probe: NetProbe, options: PollOptions = {}): Promise<ProbeResult> {
  const { timeoutMs = 60_000, intervalMs = DEFAULT_INTERVAL_MS, signal, probeFn = probeOnce } = options;
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = { ok: false };

  for (;;) {
    if (signal?.aborted) throw new ProbeAborted();
    last = await probeFn(probe);
    if (last.ok) return last;
    if (signal?.aborted) throw new ProbeAborted();
    if (Date.now() >= deadline) {
      throw new Error(
        `${describeProbe(probe)} never answered within ${timeoutMs}ms` +
          (last.detail ? ` (last: ${last.detail})` : ''),
      );
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
