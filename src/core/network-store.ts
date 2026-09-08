import { EventEmitter } from 'node:events';
import type { NetworkRequestSnapshot } from './types.ts';

/** Rows kept per session. A busy app fills this in a couple of minutes. */
const DEFAULT_CAP = 500;

/** How many rows `list()` returns when the caller does not say. */
const DEFAULT_TAIL = 200;

export type NetworkQuery = {
  /** Only requests that started at or after this millisecond timestamp. */
  since?: number;
  /** Case-insensitive regular expression, matched against `"METHOD uri"`. */
  filter?: string;
  /** How many of the matching rows to return, newest last. Default 200. */
  tail?: number;
};

/**
 * The daemon's memory of what each session's app has been talking to.
 *
 * Deliberately in-memory and bounded: this is a live inspector, not an archive.
 * The buffer inside the app is bounded too, and once a session's process is gone
 * the traffic it made is no longer reproducible anyway -- so the honest thing is
 * a capped window that is cheap to keep, not a log that pretends to be complete.
 *
 * Rows are keyed by request id and held in arrival order. An in-flight request
 * that later finishes arrives again under the same id and replaces its row in
 * place, which is what makes a HUD table update rather than grow.
 */
export class NetworkStore extends EventEmitter {
  #cap: number;
  #bySession = new Map<string, Map<string, NetworkRequestSnapshot>>();

  constructor(cap = DEFAULT_CAP) {
    super();
    this.#cap = cap;
  }

  /** Record (or update) one request and tell listeners, so it can be pushed onward. */
  upsert(sessionId: string, request: NetworkRequestSnapshot): void {
    let rows = this.#bySession.get(sessionId);
    if (!rows) this.#bySession.set(sessionId, (rows = new Map()));

    // The store, not the monitor, is authoritative about which session a row
    // belongs to -- a monitor constructed without one would otherwise leak an
    // empty sessionId out to clients.
    const row = request.sessionId === sessionId ? request : { ...request, sessionId };
    // `Map.set` on an existing key keeps its original position, so a finished
    // request does not jump to the end of the table it was already in.
    rows.set(row.id, row);

    while (rows.size > this.#cap) {
      const oldest = rows.keys().next();
      if (oldest.done) break;
      rows.delete(oldest.value);
    }
    this.emit('request', sessionId, row);
  }

  list(sessionId: string, query: NetworkQuery = {}): NetworkRequestSnapshot[] {
    const rows = this.#bySession.get(sessionId);
    if (!rows) return [];

    let matches = [...rows.values()];
    if (query.since !== undefined) matches = matches.filter((r) => r.startTime >= query.since!);
    if (query.filter) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(query.filter, 'i');
      } catch (err) {
        // A typo'd regex returning nothing looks exactly like "no traffic
        // matched", which sends the caller hunting for the wrong bug.
        throw new Error(`invalid network filter "${query.filter}": ${(err as Error).message}`);
      }
      matches = matches.filter((r) => pattern.test(`${r.method} ${r.uri}`) || [r.traceId, r.error, r.statusCode?.toString()].some((value) => value !== undefined && pattern.test(value)));
    }
    return matches.slice(-(query.tail ?? DEFAULT_TAIL));
  }

  /**
   * Cheap totals for `summary` -- no tailing, no filtering, just counts over
   * the whole captured window.
   */
  counts(sessionId: string): { total: number; failed: number; inFlight: number } {
    const rows = this.#bySession.get(sessionId);
    if (!rows) return { total: 0, failed: 0, inFlight: 0 };
    let failed = 0;
    let inFlight = 0;
    for (const row of rows.values()) {
      if (row.error || (row.statusCode !== undefined && row.statusCode >= 400)) failed++;
      if (row.inProgress) inFlight++;
    }
    return { total: rows.size, failed, inFlight };
  }

  /** Empty a session's rows, keeping the session itself. */
  clear(sessionId: string): void {
    this.#bySession.get(sessionId)?.clear();
  }

  /** Forget a session entirely -- it has been removed from the registry. */
  drop(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }
}
