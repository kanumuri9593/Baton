import { join } from 'node:path';
import type { SessionRegistry } from '../core/registry.ts';
import { LogHistory, RunLogWriter, safe } from '../core/log-store.ts';
import { sessionLogDir } from '../core/paths.ts';
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
 * One wrinkle: a session's own `setStatus('stopped'|'failed')` already fires
 * `change` directly, and the registry *also* re-emits `change` a second time
 * off the session's `exit` event a moment later -- so every ordinary exit
 * delivers two `change` snapshots with the same terminal status, not one.
 * Naively reopening a writer whenever none is on hand would turn that into a
 * second header/exit pair appended to the same file on every single run.
 * `#closedRuns` remembers which specific run (by runId, not by session id --
 * a project's target keeps the same session id across separate runs) has
 * already been closed, so the second `change` in that pair is a no-op.
 */
export class LogSink {
  #registry: SessionRegistry;
  #history: LogHistory;
  #writers = new Map<string, RunLogWriter>();
  #closedRuns = new Set<string>();

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
    const runId = runIdFor(snapshot);
    if (this.#closedRuns.has(runId)) return; // the second of the two `change`s an exit delivers

    let writer = this.#writers.get(snapshot.id);
    if (!writer) writer = this.#open(snapshot, runId);

    if (snapshot.status === 'stopped' || snapshot.status === 'failed') {
      this.#closedRuns.add(runId);
      this.#writers.delete(snapshot.id);
      writer.close(snapshot.exitCode ?? null).catch(() => { /* RunLogWriter never rejects; defensive only */ });
      this.#history.prune();
    }
  }

  #onLog(sessionId: string, text: string, error: boolean, at?: number): void {
    let writer = this.#writers.get(sessionId);
    if (!writer) {
      // A log line arriving before the first `change` event is not expected
      // (the registry emits `change` synchronously right after `start()`),
      // but if it ever happens, open the writer from the session's own
      // current snapshot rather than dropping the line -- unless the run has
      // already ended, in which case this is a straggler arriving after its
      // exit record and there is nowhere left to put it.
      const session = this.#registry.get(sessionId);
      if (!session || session.status === 'stopped' || session.status === 'failed') return;
      const snapshot = session.snapshot();
      writer = this.#open(snapshot, runIdFor(snapshot));
    }
    writer.append({ at: at ?? Date.now(), text, error });
  }

  #open(snapshot: SessionSnapshot, runId: string): RunLogWriter {
    const path = join(sessionLogDir(), `${runId}.jsonl`);
    const writer = new RunLogWriter(path, { runId, session: snapshot, root: snapshot.root ?? null });
    this.#writers.set(snapshot.id, writer);
    return writer;
  }
}

/** The run's filename stem: the moment its session was created, plus a filesystem-safe id. */
function runIdFor(snapshot: SessionSnapshot): string {
  return `${snapshot.startedAt}-${safe(snapshot.id)}`;
}
