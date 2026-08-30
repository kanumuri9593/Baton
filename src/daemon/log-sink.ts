import { join } from 'node:path';
import type { SessionRegistry } from '../core/registry.ts';
import { LogHistory, RunLogWriter, safe } from '../core/log-store.ts';
import type { SessionSnapshot } from '../core/types.ts';

/**
 * Bridges the registry's live events to on-disk per-run logs.
 *
 * The registry has no concept of "exit" beyond re-broadcasting a `change` --
 * see `../core/registry.ts`, which listens to each session's own `exit` event
 * only to turn it into a `change` with a fresh snapshot. So a run's end is
 * detected here the same way: a `change` snapshot whose status has reached
 * `stopped` or `failed`. (Session-level `exit` also carries the exit code,
 * but by the time it reaches the registry that information already lives on
 * the snapshot as `exitCode`, so re-deriving it from `change` loses nothing.)
 *
 * The registry's `log` event carries `(sessionId, text, error)` -- no
 * timestamp, because `BaseSession.appendLog` does not emit the one it puts in
 * its own ring buffer. `SessionRegistry` was extended to pass that timestamp
 * through as an optional fourth argument (see the accompanying change to
 * `appendLog`/`registry.ts`); older/other emitters that only send three
 * arguments still work, falling back to `Date.now()` at the sink.
 *
 * Two wrinkles, both real (found empirically, not from reading the brief):
 *
 * 1. A session's own `setStatus('stopped'|'failed')` already fires `change`
 *    directly, and the registry *also* re-emits `change` a second time off
 *    the session's `exit` event a moment later -- every ordinary exit
 *    delivers two `change` snapshots with the same terminal status, not one.
 *
 * 2. A hot restart (`ProcessSession.hotRestart`: stop, then start again on
 *    the *same* session object) reuses the session's id and `startedAt`, so
 *    it reuses the exact same runId and file -- a new segment of the same
 *    run's file, not a new run. Two restarts back to back can deliver a
 *    second open before the first open (which may itself still be waiting
 *    on a prior close of the same file) has finished; naive dedup-by-id
 *    tracking of "one open/close in flight" collapses that second, distinct
 *    request into the first one instead of queuing behind it -- which is
 *    exactly how a real exit record went missing during review (a restart
 *    fast enough to outrun the previous segment's own open).
 *
 * `#queues` fixes both: every open/close for one session id is processed
 * through a single strictly-ordered chain, one at a time, in the exact order
 * the triggering `change`/`log` events occurred. A redundant close finds
 * nothing to close (the first one in the chain already removed it) and is a
 * no-op; a fast-arriving open or close for the next segment simply waits its
 * turn instead of racing or merging with whatever came before it.
 */
export class LogSink {
  #registry: SessionRegistry;
  #history: LogHistory;
  #writers = new Map<string, RunLogWriter>();
  /** sessionId -> the tail of its strictly-ordered open/close/append chain. */
  #queues = new Map<string, Promise<unknown>>();

  constructor(registry: SessionRegistry, history: LogHistory) {
    this.#registry = registry;
    this.#history = history;

    // Best-effort at startup: a daemon that ran for a while before restarting
    // should not have unbounded history waiting for its next run to end.
    this.#history.prune();

    registry.on('change', (snapshot: SessionSnapshot) => this.#onChange(snapshot));
    registry.on('log', (sessionId: string, text: string, error: boolean, at?: number) =>
      this.#onLog(sessionId, text, error, at),
    );
  }

  #onChange(snapshot: SessionSnapshot): void {
    const terminal = snapshot.status === 'stopped' || snapshot.status === 'failed';
    this.#enqueue(snapshot.id, () => (terminal ? this.#closeIfOpen(snapshot) : this.#openIfClosed(snapshot)));
  }

  #onLog(sessionId: string, text: string, error: boolean, at?: number): void {
    // Fast path: a writer is already open (true for the overwhelming
    // majority of log lines), so most appends never touch the queue at all.
    const writer = this.#writers.get(sessionId);
    if (writer) {
      writer.append({ at: at ?? Date.now(), text, error });
      return;
    }

    // No writer yet. Either its own `open` is still ahead of us in the
    // queue (in which case queuing behind it and appending once it's done
    // is exactly right), or the run has already ended and this is a
    // straggler line with nowhere left to go.
    const session = this.#registry.get(sessionId);
    if (!session) return;
    this.#enqueue(sessionId, async () => {
      if (session.status === 'stopped' || session.status === 'failed') return;
      const opened = await this.#openIfClosed(session.snapshot());
      opened.append({ at: at ?? Date.now(), text, error });
    });
  }

  /** Run `task` after every previously enqueued task for this session id, in order. */
  #enqueue(sessionId: string, task: () => Promise<unknown>): void {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    // `task` runs whether the previous link settled or not -- a queue must
    // never wedge permanently just because one earlier task somehow threw.
    const next = previous.then(task, task);
    this.#queues.set(sessionId, next.catch(() => {}));
  }

  async #openIfClosed(snapshot: SessionSnapshot): Promise<RunLogWriter> {
    const existing = this.#writers.get(snapshot.id);
    if (existing) return existing;

    const runId = runIdFor(snapshot);
    const path = join(this.#history.dir, `${runId}.jsonl`);
    const writer = new RunLogWriter(path, { runId, session: snapshot, root: snapshot.root ?? null });
    this.#writers.set(snapshot.id, writer);
    return writer;
  }

  async #closeIfOpen(snapshot: SessionSnapshot): Promise<void> {
    const writer = this.#writers.get(snapshot.id);
    if (!writer) return; // the redundant second `change` of an exit pair, or nothing was ever opened
    this.#writers.delete(snapshot.id);
    await writer.close(snapshot.exitCode ?? null);
    this.#history.prune();
  }
}

/** The run's filename stem: the moment its session was created, plus a filesystem-safe id. */
function runIdFor(snapshot: SessionSnapshot): string {
  return `${snapshot.startedAt}-${safe(snapshot.id)}`;
}
