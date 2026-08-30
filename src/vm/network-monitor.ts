import { EventEmitter } from 'node:events';
import { VmServiceError, type VmServiceClient } from './vm-client.ts';
import type { NetworkBody, NetworkRequestDetail, NetworkRequestSnapshot } from '../core/types.ts';

/** JSON-RPC "method not found": the dart:io extension has not registered yet. */
const METHOD_NOT_FOUND = -32601;

/** How many polls in a row may fail completely before we call the app gone. */
const FAILURE_LIMIT = 3;

/** Default body cap. Enough for any sane JSON payload, small enough to page around. */
export const MAX_BODY = 262_144;

export type NetworkMonitorOptions = {
  /** Which Baton session these requests belong to; stamped onto every snapshot. */
  sessionId?: string;
  pollIntervalMs?: number;
  /** Delay before the single retry of a -32601 enable. Zero in tests. */
  retryDelayMs?: number;
};

/**
 * Turns one app's dart:io HTTP traffic into a stream of normalized snapshots.
 *
 * The VM service has no push channel for HTTP profiling -- `getHttpProfile` is a
 * poll, and the profile lives in a ring buffer inside the app. So this polls on
 * an interval and asks only for what changed, using the `timestamp` the previous
 * answer carried rather than our own clock: the two machines are the same
 * machine today, but the profile's notion of "now" is the app's, and borrowing
 * it costs nothing and cannot skew.
 *
 * What this can and cannot see is a property of dart:io, not of this code: it
 * captures `HttpClient` traffic (which is what `package:http` and `dio`'s default
 * adapter use) and nothing else -- not cupertino_http/cronet_http's native
 * clients, not WebSockets, not raw sockets. Every surface says so out loud.
 *
 * Events: `request` (a normalized upsert -- the same id arrives again when an
 * in-flight request finishes) and `detached` (capture has stopped for good).
 */
export class NetworkMonitor extends EventEmitter {
  #client: VmServiceClient;
  #sessionId: string;
  #pollIntervalMs: number;
  #retryDelayMs: number;

  /** Isolates with HTTP timeline logging successfully turned on. */
  #enabled = new Set<string>();
  /** Per isolate, the `timestamp` of its last profile answer -- the next `updatedSince`. */
  #since = new Map<string, number>();
  #timer?: ReturnType<typeof setInterval>;
  #consecutiveFailures = 0;
  #stopped = false;

  constructor(client: VmServiceClient, options: NetworkMonitorOptions = {}) {
    super();
    this.#client = client;
    this.#sessionId = options.sessionId ?? '';
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /** The isolates currently being captured. */
  get isolates(): readonly string[] {
    return [...this.#enabled];
  }

  /**
   * Turn capture on and start polling.
   *
   * Throws only when NOT ONE isolate could be enabled -- that is the case where
   * claiming the `network` capability would be a lie. A partial success (one of
   * two isolates) still captures something, so it is not a failure.
   */
  async attach(): Promise<void> {
    const vm = await this.#client.request<{ isolates?: { id: string }[] }>('getVM', {});
    const isolates = vm?.isolates ?? [];
    for (const isolate of isolates) await this.#enable(isolate.id);

    if (this.#enabled.size === 0) {
      throw new Error(
        isolates.length === 0
          ? 'the VM service reported no isolates to capture from'
          : 'no isolate accepted HTTP timeline logging (the dart:io extension never registered)',
      );
    }

    // Registered before subscribing, so an event that arrives with the
    // subscription's own reply is not dropped.
    this.#client.onStreamEvent('Isolate', (event) => this.#onIsolateEvent(event));
    await this.#client.streamListen('Isolate');

    this.#timer = setInterval(() => void this.pollOnce(), this.#pollIntervalMs);
    // The daemon must still be able to exit while a session is being captured.
    this.#timer.unref?.();
  }

  /**
   * One round of polling, across every enabled isolate.
   *
   * A failed poll is swallowed: an app mid-hot-restart, or one whose isolate is
   * momentarily not runnable, answers with an error for a second or two and then
   * recovers. Only a total failure three rounds running is treated as the app
   * being gone.
   */
  async pollOnce(): Promise<void> {
    if (this.#stopped) return;
    const isolates = [...this.#enabled];
    if (isolates.length === 0) return;

    let failures = 0;
    for (const isolateId of isolates) {
      try {
        const since = this.#since.get(isolateId);
        const profile = await this.#client.request<{ timestamp?: number; requests?: any[] }>(
          'ext.dart.io.getHttpProfile',
          since === undefined ? { isolateId } : { isolateId, updatedSince: since },
        );
        if (typeof profile?.timestamp === 'number') this.#since.set(isolateId, profile.timestamp);
        for (const ref of profile?.requests ?? []) {
          this.emit('request', normalizeRequest(this.#sessionId, isolateId, ref));
        }
      } catch {
        failures++;
      }
    }

    if (failures < isolates.length) {
      this.#consecutiveFailures = 0;
      return;
    }
    if (++this.#consecutiveFailures < FAILURE_LIMIT) return;
    this.#stopPolling();
    this.emit('detached');
  }

  /** The full record for one request, bodies included. Only available while the app runs. */
  fetchDetail(isolateId: string, id: string): Promise<any> {
    return this.#client.request<any>('ext.dart.io.getHttpProfileRequest', { isolateId, id });
  }

  /** Drop the profile buffered inside the app, freeing its memory. */
  async clear(): Promise<void> {
    for (const isolateId of this.#enabled) {
      await this.#client.request('ext.dart.io.clearHttpProfile', { isolateId }).catch(() => {});
    }
  }

  dispose(): void {
    this.#stopPolling();
    this.#client.close();
  }

  #stopPolling(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Turn capture on for one isolate, retrying a -32601 once.
   *
   * `ext.dart.io.*` extensions register when dart:io is first touched, which can
   * be a beat after the isolate is runnable. A single retry covers that race;
   * anything else (or a second -32601) means this isolate never will support it,
   * and giving up on it quietly is right -- the other isolates may be fine.
   */
  async #enable(isolateId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.#client.request('ext.dart.io.httpEnableTimelineLogging', { isolateId, enabled: true });
        this.#enabled.add(isolateId);
        return true;
      } catch (err) {
        const retriable = err instanceof VmServiceError && err.code === METHOD_NOT_FOUND;
        if (!retriable || attempt === 1) return false;
        await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs));
      }
    }
    return false;
  }

  /**
   * Follow the app's isolates across a hot restart.
   *
   * A hot restart does not reuse the isolate -- it creates a new one, and capture
   * on the old one dies with it. `IsolateRunnable` (not `IsolateStart`, which is
   * too early for the extension to exist) is the moment to enable the new one;
   * the -32601 retry inside `#enable` covers what is left of the race.
   */
  #onIsolateEvent(event: any): void {
    const isolateId = event?.isolate?.id;
    if (typeof isolateId !== 'string') return;
    if (event.kind === 'IsolateRunnable') {
      if (this.#stopped || this.#enabled.has(isolateId)) return;
      void this.#enable(isolateId);
    } else if (event.kind === 'IsolateExit') {
      this.#enabled.delete(isolateId);
      this.#since.delete(isolateId);
    }
  }
}

// --- normalization ----------------------------------------------------------

/** Microseconds since the epoch to milliseconds, the unit every surface uses. */
const ms = (micros: number): number => Math.round(micros / 1000);

/** dart:io reports -1 for "no content length was known", which is not a length. */
const length = (value: unknown): number | undefined =>
  typeof value === 'number' && value >= 0 ? value : undefined;

/**
 * Header values as lists.
 *
 * The VM service sends either a single string or a list per header, depending on
 * how the header was set. Clients should not have to branch on that, so one
 * shape wins. Key case is left exactly as the app sent it -- an inspector that
 * silently rewrites what went over the wire is lying about it.
 */
export function normalizeHeaders(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = Array.isArray(value) ? value.map(String) : [String(value)];
  }
  return out;
}

/** First value of a header, matched case-insensitively. */
export function headerValue(headers: Record<string, string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return values[0];
  }
  return undefined;
}

/**
 * A `HttpProfileRequestRef` as the rest of Baton sees it.
 *
 * `id` is namespaced by isolate: request ids restart from 1 in every isolate, so
 * a hot restart would otherwise overwrite the previous run's rows.
 */
export function normalizeRequest(sessionId: string, isolateId: string, ref: any): NetworkRequestSnapshot {
  const request = ref?.request ?? {};
  const response = ref?.response ?? {};
  const responseHeaders = normalizeHeaders(response.headers);
  const finished = typeof ref?.endTime === 'number';

  return {
    id: `${isolateId}#${ref?.id}`,
    sessionId,
    method: String(ref?.method ?? ''),
    uri: String(ref?.uri ?? ''),
    startTime: ms(Number(ref?.startTime ?? 0)),
    endTime: finished ? ms(ref.endTime) : undefined,
    // Rounded from the microsecond difference rather than subtracting two
    // already-rounded millisecond values, which can be a millisecond out.
    durationMs: finished ? ms(ref.endTime - Number(ref.startTime ?? 0)) : undefined,
    statusCode: typeof response.statusCode === 'number' ? response.statusCode : undefined,
    reasonPhrase: response.reasonPhrase ? String(response.reasonPhrase) : undefined,
    requestContentLength: length(request.contentLength),
    responseContentLength: length(response.contentLength),
    contentType: headerValue(responseHeaders, 'content-type'),
    error: request.error ?? response.error,
    inProgress: !finished,
  };
}

/** The full `HttpProfileRequest`, bodies decoded and headers flattened. */
export function normalizeDetail(
  sessionId: string,
  isolateId: string,
  raw: any,
  maxBody = MAX_BODY,
): NetworkRequestDetail {
  const request = raw?.request ?? {};
  const response = raw?.response;
  return {
    ...normalizeRequest(sessionId, isolateId, raw),
    requestHeaders: normalizeHeaders(request.headers),
    responseHeaders: response ? normalizeHeaders(response.headers) : undefined,
    cookies: Array.isArray(request.cookies) ? request.cookies.map(String) : [],
    redirects: Array.isArray(response?.redirects) ? response.redirects : [],
    connectionInfo: request.connectionInfo ?? undefined,
    proxy: request.proxyDetails ?? undefined,
    events: (Array.isArray(raw?.events) ? raw.events : []).map((e: any) => ({
      event: String(e?.event ?? ''),
      timestamp: ms(Number(e?.timestamp ?? 0)),
      arguments: e?.arguments,
    })),
    requestBody: decodeBody(raw?.requestBody, maxBody),
    responseBody: decodeBody(raw?.responseBody, maxBody),
  };
}

/**
 * Bytes to something a client can display or reconstruct.
 *
 * `base64` is the source of truth -- always the exact bytes, capped. `text` is
 * offered only when they decode as strict UTF-8, so a binary payload is shown as
 * binary instead of as mojibake. A cap landing mid-character would fail that
 * strict decode for what is plainly text, so up to three trailing bytes are
 * dropped from the *preview* (never from `base64`) to find the last whole
 * character.
 */
export function decodeBody(bytes: unknown, maxBody = MAX_BODY): NetworkBody | undefined {
  if (!Array.isArray(bytes)) return undefined;
  const size = bytes.length;
  const truncated = size > maxBody;
  const buffer = Buffer.from(truncated ? bytes.slice(0, maxBody) : bytes);
  return { base64: buffer.toString('base64'), text: asUtf8(buffer, truncated), size, truncated };
}

function asUtf8(buffer: Buffer, truncated: boolean): string | undefined {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const backoff = truncated ? 3 : 0;
  for (let drop = 0; drop <= backoff && drop < buffer.length + 1; drop++) {
    try {
      return decoder.decode(buffer.subarray(0, buffer.length - drop));
    } catch {
      /* try one byte shorter -- the cap may have split a character */
    }
  }
  return undefined;
}
