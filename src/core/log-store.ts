import {
  createWriteStream, type WriteStream,
  mkdirSync, readdirSync, statSync, unlinkSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { LogLine, SessionSnapshot } from './types.ts';

/**
 * Persistent per-run logs, so a run survives a daemon restart.
 *
 * Sessions keep their own in-memory ring untouched (`BaseSession.appendLog`) --
 * this is a purely daemon-side concern, wired up by `../daemon/log-sink.ts`.
 * One JSONL file per run: a header line, then raw log lines, then (once the
 * run ends) an exit marker. Everything here is written defensively: a broken
 * disk must never take the daemon down with it.
 */

/** Per-file byte cap. Beyond this, one truncated marker is written and the rest is dropped. */
export const MAX_RUN_LOG_BYTES = 25 * 1024 * 1024;
/** How many run files `LogHistory.prune()` keeps, newest first. */
export const MAX_RUNS = 200;
/** Total on-disk budget `LogHistory.prune()` enforces across all runs. */
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

const DEFAULT_TAIL = 200;
const EXTENSION = '.jsonl';
/** How far from the end of a file to look for the exit record -- cheap and plenty. */
const TAIL_SCAN_BYTES = 4096;
/** How far into a file to look for the header line. */
const HEADER_SCAN_BYTES = 64 * 1024;

/** Replace anything hostile to a filename (including path separators) with `_`. */
export function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export type RunHeader = {
  runId: string;
  session: SessionSnapshot;
  root: string | null;
};

export type RunInfo = {
  runId: string;
  sessionId: string;
  name: string;
  kind: string;
  root: string | null;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  sizeBytes: number;
  live: boolean;
};

type RawRecord =
  | { kind: 'header'; runId: string; session: SessionSnapshot; root: string | null }
  | { kind: 'exit'; code: number | null; at: number }
  | { kind: 'truncated'; at: number }
  | LogLine;

/**
 * Appends one run's worth of log lines to disk as JSONL.
 *
 * Never throws: a filesystem problem (a full disk, a missing directory that
 * cannot be created, a permissions error) disables the writer after logging
 * one warning, and every subsequent call becomes a silent no-op. Logging is a
 * diagnostic nicety; it must never be the reason a session dies.
 */
export class RunLogWriter {
  readonly runId: string;

  #stream: WriteStream | null = null;
  #bytesWritten = 0;
  #truncated = false;
  #disabled = false;
  #warned = false;
  #closed = false;
  #maxBytes: number;
  // Chains every write so `flush()`/`close()` can wait for all of them to have
  // actually reached the fd -- `stream.write()` queues asynchronously, and a
  // caller that reads the file right after `append()` must see it land there.
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string, header: RunHeader, options: { maxBytes?: number } = {}) {
    this.runId = header.runId;
    this.#maxBytes = options.maxBytes ?? MAX_RUN_LOG_BYTES;

    try {
      mkdirSync(dirname(path), { recursive: true });
      const stream = createWriteStream(path, { flags: 'a' });
      stream.on('error', (err) => this.#fail(err));
      this.#stream = stream;
    } catch (err) {
      this.#fail(err as Error);
      return;
    }
    this.#writeRecord({ kind: 'header', runId: header.runId, session: header.session, root: header.root });
  }

  /** Append one log line, unless the writer is disabled or already truncated. */
  append(line: LogLine): void {
    if (this.#disabled || this.#truncated || this.#closed) return;
    this.#writeRecord({ at: line.at, text: line.text, error: line.error });
    if (!this.#disabled && !this.#truncated && this.#bytesWritten > this.#maxBytes) {
      this.#truncated = true;
      this.#writeRecord({ kind: 'truncated', at: Date.now() });
    }
  }

  /** Resolve once every write so far has actually reached the file descriptor. */
  flush(): Promise<void> {
    return this.#pending;
  }

  /** Write the exit marker (if the writer is still healthy), flush, and end the stream. */
  async close(code: number | null): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#disabled) {
      this.#writeRecord({ kind: 'exit', code, at: Date.now() });
    }
    await this.#pending;
    const stream = this.#stream;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }

  #writeRecord(record: RawRecord): void {
    if (this.#disabled || !this.#stream) return;
    const stream = this.#stream;
    const line = JSON.stringify(record) + '\n';
    this.#bytesWritten += Buffer.byteLength(line);
    this.#pending = this.#pending.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.#disabled || !this.#stream) return resolve();
          try {
            stream.write(line, (err) => {
              if (err) this.#fail(err);
              resolve();
            });
          } catch (err) {
            this.#fail(err as Error);
            resolve();
          }
        }),
    );
  }

  #fail(err: Error): void {
    if (this.#disabled) return;
    this.#disabled = true;
    if (!this.#warned) {
      this.#warned = true;
      console.error(`baton: run log writer for ${this.runId} failed and is disabled: ${(err as Error).message}`);
    }
    try {
      this.#stream?.destroy();
    } catch {
      /* already going down */
    }
    this.#stream = null;
  }
}

/**
 * Reads and prunes the on-disk run log store.
 *
 * Tolerant by design: a corrupt or half-written file is skipped (`list`) or
 * has its bad line(s) dropped (`read`) rather than throwing -- a crash mid
 * write must never make history unreadable.
 */
export class LogHistory {
  #dir: string;
  #maxRuns: number;
  #maxTotalBytes: number;

  constructor(dir: string, options: { maxRuns?: number; maxTotalBytes?: number } = {}) {
    this.#dir = dir;
    this.#maxRuns = options.maxRuns ?? MAX_RUNS;
    this.#maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort -- callers that actually write will fail loudly-once themselves */
    }
  }

  /**
   * The directory this store reads from and writes to.
   *
   * A writer (`LogSink`) must derive its own path from *this*, not from
   * `sessionLogDir()` directly -- otherwise an injected `LogHistory` pointed
   * at a different directory (the whole point of it being injectable) would
   * write to one place and read from another, silently.
   */
  get dir(): string {
    return this.#dir;
  }

  /** Every run, newest first, tolerating unreadable or corrupt files by skipping them. */
  list(root?: string): RunInfo[] {
    const infos: RunInfo[] = [];
    for (const file of this.#files()) {
      const info = this.#readInfo(join(this.#dir, file));
      if (!info) continue;
      if (root && info.root !== root) continue;
      infos.push(info);
    }
    infos.sort((a, b) => b.startedAt - a.startedAt);
    return infos;
  }

  /** Whether `read()` would find a run for this query -- a full runId, a prefix, or a sessionId. */
  has(runId: string): boolean {
    return this.#resolvePath(runId) !== undefined;
  }

  /**
   * Read one run's lines.
   *
   * `runId` may be a full runId, an unambiguous prefix of one, or a sessionId
   * (in which case its most recent run is used). Tail is applied before the
   * filter, matching the live `logs` RPC exactly.
   */
  read(runId: string, opts: { tail?: number; filter?: string } = {}): LogLine[] {
    const path = this.#resolvePath(runId);
    if (!path) return [];
    const lines = this.#parseLines(path);
    const tailed = lines.slice(-(opts.tail ?? DEFAULT_TAIL));
    if (!opts.filter) return tailed;
    const re = new RegExp(opts.filter, 'i');
    return tailed.filter((l) => re.test(l.text));
  }

  /** Keep only the newest `maxRuns` runs, and no more than `maxTotalBytes` total. */
  prune(): void {
    const infos = this.list();
    let total = 0;
    let kept = 0;
    for (const info of infos) {
      total += info.sizeBytes;
      kept += 1;
      if (kept > this.#maxRuns || total > this.#maxTotalBytes) {
        try {
          unlinkSync(join(this.#dir, `${info.runId}${EXTENSION}`));
        } catch {
          /* already gone, or a permissions problem -- either way, move on */
        }
      }
    }
  }

  #files(): string[] {
    try {
      return readdirSync(this.#dir).filter((f) => f.endsWith(EXTENSION));
    } catch {
      return [];
    }
  }

  /** Full runId, then an unambiguous filename prefix, then "latest run for this sessionId". */
  #resolvePath(runId: string): string | undefined {
    const files = this.#files();
    const exact = files.find((f) => f.slice(0, -EXTENSION.length) === runId);
    if (exact) return join(this.#dir, exact);

    const prefixed = files.filter((f) => f.startsWith(runId));
    if (prefixed.length === 1) return join(this.#dir, prefixed[0]);

    let best: { file: string; startedAt: number } | undefined;
    for (const file of files) {
      const info = this.#readInfo(join(this.#dir, file));
      if (!info || info.sessionId !== runId) continue;
      if (!best || info.startedAt > best.startedAt) best = { file, startedAt: info.startedAt };
    }
    return best ? join(this.#dir, best.file) : undefined;
  }

  /** Header fields plus exit info scraped from the tail of the file. */
  #readInfo(path: string): RunInfo | undefined {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return undefined;
    }

    const headerLine = readFirstLine(path, HEADER_SCAN_BYTES);
    if (!headerLine) return undefined;
    let header: any;
    try {
      header = JSON.parse(headerLine);
    } catch {
      return undefined;
    }
    if (header?.kind !== 'header') return undefined;

    const { endedAt, exitCode } = scanExit(path, size);

    return {
      runId: header.runId,
      sessionId: header.session?.id ?? header.runId,
      name: header.session?.name ?? header.runId,
      kind: header.session?.kind ?? 'process',
      root: header.root ?? null,
      startedAt: header.session?.startedAt ?? 0,
      endedAt,
      exitCode,
      sizeBytes: size,
      live: false,
    };
  }

  /** Parse the file's log lines, skipping the header, exit/truncated markers, and any torn final line. */
  #parseLines(path: string): LogLine[] {
    let raw: string;
    try {
      raw = readFileSyncSafe(path);
    } catch {
      return [];
    }
    const rows = raw.split('\n').filter((l) => l.length > 0);
    const lines: LogLine[] = [];
    for (const row of rows) {
      let record: any;
      try {
        record = JSON.parse(row);
      } catch {
        continue; // torn line (typically the last one) -- skip it, don't throw
      }
      if (record && typeof record === 'object' && !('kind' in record)) {
        lines.push({ at: record.at, text: record.text, error: Boolean(record.error) });
      }
      // header / exit / truncated records carry a `kind` and are not log lines.
    }
    return lines;
  }
}

/** Read up to `maxBytes` from the start of the file and return its first `\n`-terminated line. */
function readFirstLine(path: string, maxBytes: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.toString('utf8', 0, read);
    const nl = text.indexOf('\n');
    return nl === -1 ? (read > 0 ? text : undefined) : text.slice(0, nl);
  } catch {
    return undefined;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Look at the last `TAIL_SCAN_BYTES` of the file for an exit record.
 *
 * A hot-restarted session can leave *several* header/exit pairs in one file
 * (LogSink opens a fresh writer per restart segment, all appended to the
 * same path). Scanning backward from the end of the file and returning on
 * the first match is deliberate, not incidental: it is exactly "the last
 * exit record in the file", i.e. the most recent one, never an earlier
 * (stale) one from a prior segment -- even when more than one falls inside
 * the scanned window. The true final exit record, if the run has one, is
 * always the very last complete line of the file (nothing is ever appended
 * after a writer's own `close()`), so it is always within this window
 * regardless of how much log output precedes it.
 */
function scanExit(path: string, size: number): { endedAt?: number; exitCode?: number | null } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return {};
  }
  try {
    const length = Math.min(size, TAIL_SCAN_BYTES);
    const position = Math.max(0, size - length);
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, position);
    const text = buf.toString('utf8', 0, read);
    const rows = text.split('\n').filter((l) => l.length > 0);
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(rows[i]);
        if (record?.kind === 'exit') return { endedAt: record.at, exitCode: record.code };
      } catch {
        continue; // possibly a torn line at the very end -- ignore and keep scanning back
      }
    }
    return {};
  } catch {
    return {};
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function readFileSyncSafe(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(size);
    const read = readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8', 0, read);
  } finally {
    closeSync(fd);
  }
}
