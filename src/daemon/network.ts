import type { SessionRegistry } from '../core/registry.ts';
import type { NetworkStore } from '../core/network-store.ts';
import type { NetworkRequestDetail, Session, SessionSnapshot } from '../core/types.ts';
import { NetworkMonitor, normalizeDetail } from '../vm/network-monitor.ts';
import { VmServiceClient, connectVmWs } from '../vm/vm-client.ts';

/** How a monitor gets its connection. Injected in tests so no socket is opened. */
export type CreateVmClient = (uri: string) => Promise<VmServiceClient>;

export type NetworkServiceOptions = {
  /** Poll interval handed to every monitor; the monitor's own default when unset. */
  pollIntervalMs?: number;
  /** First backoff after a failed attach; doubles with each further failure. */
  retryBaseMs?: number;
};

/**
 * How long to wait after a failed attach before trying that session again, and
 * how many times.
 *
 * Retrying at all matters: the VM service can be up a moment before its isolate
 * is runnable, and the first attach genuinely can be too early. Retrying
 * *unboundedly* is the trap -- a Flutter session emits `change` on every daemon
 * event, including every line the app logs, so an attach driven straight off
 * those events becomes one connection attempt per log line. Five tries over
 * roughly half a minute covers a slow start; past that the app is telling us it
 * cannot do this.
 */
const RETRY_BASE_MS = 2000;
const MAX_ATTACH_ATTEMPTS = 5;

type AttachFailure = { attempts: number; nextAttemptAt: number };

const defaultCreateClient: CreateVmClient = async (uri) => new VmServiceClient(await connectVmWs(uri));

/**
 * Attaches HTTP capture to every session that can support it, and only those.
 *
 * The daemon owns one of these. It watches the registry: a Flutter session that
 * reaches `running` with a VM service URI gets a `NetworkMonitor` connected to
 * it, and -- only once that has actually worked -- the `network` capability.
 * That ordering is the whole point of the class. A capability is a promise to
 * every client that a call will work; granting it on "we are about to try"
 * produces a HUD button that fails when pressed, which is worse than a button
 * that is visibly disabled.
 *
 * Capture failing is not a session failing. An app built without dart:io HTTP,
 * a VM service that refuses the connection, a race lost during a hot restart --
 * all of them leave the app running and reloadable, so they cost one warning in
 * the session's own log and nothing else.
 *
 * The store outlives the monitor on purpose: after a session stops, what it
 * captured is often exactly what you want to read.
 */
export class NetworkService {
  readonly store: NetworkStore;

  #registry: SessionRegistry;
  #createClient: CreateVmClient;
  #pollIntervalMs?: number;
  #retryBaseMs: number;
  #monitors = new Map<string, NetworkMonitor>();
  /** Sessions with an attach in flight, so a burst of `change` events attaches once. */
  #attaching = new Set<string>();
  /** Sessions whose attach has failed, with when they may be tried again. */
  #failures = new Map<string, AttachFailure>();

  constructor(
    registry: SessionRegistry,
    store: NetworkStore,
    createClient: CreateVmClient = defaultCreateClient,
    options: NetworkServiceOptions = {},
  ) {
    this.#registry = registry;
    this.store = store;
    this.#createClient = createClient;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    registry.on('change', (snapshot: SessionSnapshot) => this.#consider(snapshot));
  }

  /** The live monitor for a session, if capture is running. */
  monitor(sessionId: string): NetworkMonitor | undefined {
    return this.#monitors.get(sessionId);
  }

  /** Whether a session is currently capturing -- what the `network` capability means. */
  isCapturing(sessionId: string): boolean {
    return this.#monitors.has(sessionId);
  }

  /**
   * One request in full, fetched from the app on demand.
   *
   * Not served from the store: bodies are far too big to hold for 500 requests
   * per session, and the app has them already. The cost is that detail is only
   * available while the app runs, which the error says plainly.
   */
  async detail(sessionId: string, id: string, maxBody?: number): Promise<NetworkRequestDetail> {
    const captured = this.store.list(sessionId, { tail: 500 }).find((row) => row.id === id);
    if (captured?.captureSource === 'otel-node') {
      return { ...captured, requestHeaders: {}, cookies: [], redirects: [], events: [
        { event: 'OpenTelemetry metadata only; bodies, headers and URL queries are not captured', timestamp: captured.startTime },
      ] };
    }
    const monitor = this.#monitors.get(sessionId);
    if (!monitor) {
      throw new Error(
        `${sessionId} is no longer capturing; details are only available while the app runs ` +
          '(the request list itself is still readable)',
      );
    }
    const full = this.#resolveId(sessionId, id);
    const split = full.lastIndexOf('#');
    if (split <= 0) throw new Error(`"${id}" is not a request id — use the id from the request list`);
    const isolateId = full.slice(0, split);
    const requestId = full.slice(split + 1);
    const raw = await monitor.fetchDetail(isolateId, requestId);
    return normalizeDetail(sessionId, isolateId, raw, maxBody);
  }

  /**
   * Accept the short request id a human actually reads off a table.
   *
   * Full ids carry the isolate (`isolates/1963006521159535#12`) because request
   * numbers restart at 1 in each isolate, and a hot restart makes a new one. That
   * matters to the code and not at all to the person typing `--detail 12`, so a
   * bare number is resolved against what has been captured -- and refused,
   * rather than guessed at, when two isolates both have one.
   */
  #resolveId(sessionId: string, id: string): string {
    if (id.includes('#')) return id;
    const matches = this.store.list(sessionId, { tail: Number.MAX_SAFE_INTEGER })
      .filter((row) => row.id.endsWith(`#${id}`));
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      throw new Error(
        `"${id}" matches ${matches.length} requests (the app restarted since some of them) — ` +
          `use a full id:\n${matches.map((m) => `  ${m.id}`).join('\n')}`,
      );
    }
    throw new Error(`no captured request "${id}" — check the id in the request list`);
  }

  /** Empty the captured window, and the app's own buffer while we can still reach it. */
  async clear(sessionId: string): Promise<void> {
    this.store.clear(sessionId);
    await this.#monitors.get(sessionId)?.clear();
  }

  /** Stop capturing for a session, keeping everything already captured. */
  dispose(sessionId: string): void {
    // A stopped session's failure history is worthless: whatever is next under
    // this id is a new run, and it deserves a fresh set of attempts.
    this.#failures.delete(sessionId);
    const monitor = this.#monitors.get(sessionId);
    if (!monitor) return;
    this.#monitors.delete(sessionId);
    monitor.removeAllListeners();
    monitor.dispose();
  }

  /** The session is gone from the registry: release its memory too. */
  forget(sessionId: string): void {
    this.dispose(sessionId);
    this.store.drop(sessionId);
  }

  /** Daemon shutdown: drop every connection to a VM service. */
  disposeAll(): void {
    for (const sessionId of [...this.#monitors.keys()]) this.dispose(sessionId);
  }

  /** Decide what one session's latest state means for capture. */
  #consider(snapshot: SessionSnapshot): void {
    if (snapshot.status === 'stopped' || snapshot.status === 'failed') {
      this.dispose(snapshot.id);
      return;
    }
    if (snapshot.kind !== 'flutter' || snapshot.status !== 'running') return;
    if (!snapshot.vmServiceUri) return;
    if (this.#monitors.has(snapshot.id) || this.#attaching.has(snapshot.id)) return;

    // A session that has already failed waits out its backoff. Without this,
    // every log line the app writes would buy another connection attempt --
    // `change` fires for all of them.
    const failure = this.#failures.get(snapshot.id);
    if (failure && (failure.attempts >= MAX_ATTACH_ATTEMPTS || Date.now() < failure.nextAttemptAt)) return;

    const session = this.#registry.get(snapshot.id);
    if (!session) return;
    void this.#attach(session, snapshot.vmServiceUri);
  }

  async #attach(session: Session, uri: string): Promise<void> {
    const id = session.id;
    this.#attaching.add(id);
    let monitor: NetworkMonitor | undefined;
    try {
      const client = await this.#createClient(uri);
      monitor = new NetworkMonitor(client, { sessionId: id, pollIntervalMs: this.#pollIntervalMs });
      await monitor.attach();

      // Connecting takes a moment, and an app can be stopped inside it. Attaching
      // to a session that is already gone would leave a live poll timer and an
      // open socket behind, owned by nothing.
      if (session.status !== 'running') {
        monitor.dispose();
        return;
      }

      monitor.on('request', (request) => this.store.upsert(id, request));
      monitor.on('detached', () => this.dispose(id));
      // Registered before the capability is granted: granting emits `change`,
      // which comes straight back here, and the monitor has to be findable by
      // then or this would attach a second time.
      this.#monitors.set(id, monitor);
      this.#failures.delete(id);
      grantNetwork(session);
    } catch (err) {
      monitor?.dispose();
      const attempts = (this.#failures.get(id)?.attempts ?? 0) + 1;
      this.#failures.set(id, {
        attempts,
        nextAttemptAt: Date.now() + this.#retryBaseMs * 2 ** (attempts - 1),
      });
      // Once per streak of failures. The session's own log, not the daemon's:
      // this is news about that app, and it is where anyone looking at the
      // session will see it -- which is exactly why repeating it every retry
      // would be vandalism, flooding the 2000-line ring with one message.
      if (attempts === 1) {
        warn(
          session,
          `baton: network capture unavailable — ${(err as Error).message}. ` +
            'Retrying quietly for a short while; the session is otherwise unaffected.',
        );
      }
    } finally {
      this.#attaching.delete(id);
    }
  }
}

/** `grantCapability` lives on BaseSession, which every adapter extends. */
function grantNetwork(session: Session): void {
  (session as unknown as { grantCapability?: (c: 'network') => void }).grantCapability?.('network');
}

/** Say it in the session's log if we can, and on the daemon's stderr if we cannot. */
function warn(session: Session, message: string): void {
  const appendLog = (session as unknown as { appendLog?: (text: string, error?: boolean) => void })
    .appendLog;
  if (typeof appendLog === 'function') appendLog.call(session, message, true);
  else console.error(message);
}
