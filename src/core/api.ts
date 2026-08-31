/**
 * The daemon's RPC contract, in one place.
 *
 * Types only -- nothing here runs. This is the single source of truth for what
 * a client (HUD, CLI, MCP) can ask the daemon and what it gets back, derived
 * from what `LaunchDaemon.handle()` in `../daemon/server.ts` actually reads and
 * returns. Changing the wire format means changing that switch and this file
 * together; changing only one is a bug.
 */
import type {
  LogLine, NetworkRequestDetail, NetworkRequestSnapshot, OperationResult, SessionSnapshot, SessionStatus,
} from './types.ts';
import type { Target, TargetKind } from '../config/detect.ts';
import type { ValidationIssue } from '../config/validate.ts';
import type { LaunchConfig } from '../config/loader.ts';
import type { LaunchEdit, LaunchParseError } from '../config/writer.ts';
import type { BrowseResult } from '../daemon/browse.ts';
import type { Bootable } from '../daemon/simulators.ts';
import type { Device } from '../daemon/devices.ts';
import type { WaitUntil } from '../daemon/waiter.ts';
import type { RunInfo } from './log-store.ts';

// Re-exported so a client can name what it receives without reaching into the
// daemon's own modules.
export type { BrowseEntry, BrowseResult, BrowseShortcut } from '../daemon/browse.ts';
export type { LaunchEdit, LaunchParseError } from '../config/writer.ts';

/** A detected target plus its pre-flight state, as sent to clients. */
export type TargetInfo = Target & { issues: ValidationIssue[] };

/** What one remembered project can run, tolerant of a project that has gone missing. */
export type ProjectInfo = {
  root: string;
  name: string;
  targets: Array<{ name: string; kind: TargetKind; source: Target['source']; issues: ValidationIssue[] }>;
  error?: string;
  /**
   * A real project directory with nothing Baton knows how to run.
   *
   * Set only by `addProject`, and it is an invitation rather than a failure: the
   * HUD answers it by offering to write a launch.json. Such a project is
   * deliberately NOT remembered yet -- it becomes a tracked project the moment
   * it has something to offer.
   */
  needsConfig?: boolean;
};

/** A project's launch.json as the editor needs it: the bytes, what they mean, and what is wrong. */
export type LaunchConfigView = {
  /** The file detection would use, or null when the project has none. */
  file: string | null;
  /** The file verbatim, comments and all -- a malformed file returns its text so it can be fixed. */
  text: string | null;
  /** For optimistic locking on the way back in; absent when there is no file. */
  mtimeMs?: number;
  configs: LaunchConfig[];
  /**
   * Where each of `configs` sits in the file's raw `configurations` array.
   *
   * Parallel to `configs`. An editor addresses a change by jsonc path --
   * `['configurations', 3, 'program']` -- and an entry the loader skipped (one
   * with no `name`) would otherwise put every later index off by one, so an edit
   * would land on the wrong configuration.
   */
  configIndexes: number[];
  /**
   * How many entries the raw `configurations` array holds, named or not.
   *
   * Appending a configuration means writing at exactly this index: writing at
   * `configIndexes.at(-1) + 1` instead would land ON a trailing nameless entry
   * (which `configs` skipped) and replace it rather than appending after it.
   */
  configCount: number;
  /** Pre-flight issues, keyed by configuration name. */
  issues: Record<string, ValidationIssue[]>;
  /** Non-empty when the file could not be understood; `configs` is then empty. */
  parseErrors: LaunchParseError[];
};

/** What a save produced: where it landed, and what the project now runs. */
export type LaunchWriteResult = {
  file: string;
  mtimeMs: number;
  configs: LaunchConfig[];
  issues: Record<string, ValidationIssue[]>;
};

/** Outcome of a reload/restart on one session, with the diagnostics an agent needs to act on a failure. */
export type ReloadResult = { session: string } & OperationResult & { errors?: string[] };

/** Selects which running sessions a bulk operation (`reload`, `restart`, `stop`) applies to. */
export type SessionSelector = { session?: string; all?: boolean; ids?: string[] };

/**
 * A cheap structured overview of one session -- what `summary` returns.
 *
 * Meant to be the first thing an agent reaches for after starting or reloading
 * something, instead of re-deriving the same picture from raw log lines every
 * time: is it up, what broke last, how much traffic has it made.
 */
export type SessionSummary = {
  session: SessionSnapshot;
  uptimeMs: number;
  /** Last 25 compiler/log-level error lines; see `recentErrors()` in server.ts. */
  recentErrors: string[];
  /** How many lines are currently in the session's log ring. */
  logLines: number;
  /** Only present for a session with the `network` capability. */
  network?: { total: number; failed: number; inFlight: number };
  /** The most recent reload/restart this session was asked to do, if any. */
  lastOperation?: { kind: 'reload' | 'restart'; ok: boolean; at: number; message?: string };
};

/**
 * One entry per method `LaunchDaemon.handle()` dispatches on, mapping the
 * method name to its params and result shape.
 */
export type RpcMethods = {
  targets: {
    params: { cwd?: string };
    result: { root: string; targets: TargetInfo[]; projects: string[] };
  };
  projects: {
    params: { cwd?: string };
    result: { active: string; projects: ProjectInfo[] };
  };
  addProject: {
    params: { path: string };
    result: ProjectInfo;
  };
  removeProject: {
    params: { root: string };
    result: { removed: boolean };
  };
  /**
   * One directory's worth of subdirectories, for the HUD's project browser.
   *
   * A page in a browser cannot open a native file dialog and hand the daemon a
   * path, so the daemon does the walking. Never fails: an unreadable or missing
   * directory comes back as `error` with the shortcuts intact.
   */
  browseDirs: {
    params: { path?: string };
    result: BrowseResult;
  };
  /** A project's launch.json: raw text for the editor, parsed configs for everything else. */
  readLaunchConfig: {
    params: { root?: string };
    result: LaunchConfigView;
  };
  /** What a launch.json for this project would look like. Writes nothing. */
  generateLaunchConfig: {
    params: { root?: string };
    result: { text: string; targets: TargetInfo[] };
  };
  /**
   * Replace a project's launch.json wholesale.
   *
   * `file` picks the convention for a project that has neither; a project that
   * already has one is written back to that same file rather than being shadowed
   * by a new one. `expectedMtimeMs` guards against overwriting a change someone
   * else (VS Code, another HUD window) saved in the meantime -- omitting it on a
   * retry is the deliberate "overwrite anyway".
   */
  writeLaunchConfig: {
    params: { root?: string; text: string; file?: 'vscode' | 'claude'; expectedMtimeMs?: number };
    result: LaunchWriteResult;
  };
  /** Change named values in place, leaving comments and layout untouched. */
  editLaunchConfig: {
    params: { root?: string; edits: LaunchEdit[]; expectedMtimeMs?: number };
    result: LaunchWriteResult;
  };
  /** Check launch.json text without saving it -- what the editor calls as you type. */
  validateLaunchConfig: {
    params: { root?: string; text: string };
    result: { parseErrors: LaunchParseError[]; issues: Record<string, ValidationIssue[]> };
  };
  bootables: {
    params: { cwd?: string };
    result: Bootable[];
  };
  boot: {
    params: { cwd?: string; id: string };
    result: Device;
  };
  useProject: {
    params: { root: string };
    result: { root: string };
  };
  sessions: {
    params: {};
    result: SessionSnapshot[];
  };
  devices: {
    params: { cwd?: string };
    result: Device[];
  };
  run: {
    params: { cwd?: string; target: string; deviceId?: string; force?: boolean };
    result: SessionSnapshot;
  };
  reload: {
    params: SessionSelector & { reason?: string };
    result: ReloadResult[];
  };
  restart: {
    params: SessionSelector & { reason?: string };
    result: ReloadResult[];
  };
  stop: {
    params: SessionSelector;
    result: SessionSnapshot[];
  };
  logs: {
    params: { session: string; tail?: number; filter?: string };
    result: LogLine[];
  };
  logHistory: {
    params: { root?: string; limit?: number };
    result: RunInfo[];
  };
  logRead: {
    params: { run: string; tail?: number; filter?: string };
    result: LogLine[];
  };
  serviceExtension: {
    params: { session: string; method: string; params?: Record<string, unknown> };
    result: unknown;
  };
  /**
   * Captured HTTP traffic for one session, newest last.
   *
   * Only sessions carrying the `network` capability answer this -- a session
   * without live capture refuses rather than returning an empty list, which
   * would read as "this app made no requests".
   */
  network: {
    params: { session: string; since?: number; filter?: string; tail?: number };
    result: NetworkRequestSnapshot[];
  };
  /** One request in full, fetched from the running app -- headers, timeline, bodies. */
  networkDetail: {
    params: { session: string; id: string; maxBody?: number };
    result: NetworkRequestDetail;
  };
  /** Drop the captured window, and the buffer inside the app with it. */
  networkClear: {
    params: { session: string };
    result: { cleared: boolean };
  };
  forget: {
    params: { session: string };
    result: { forgotten: boolean };
  };
  /** Capture the screen of a running session. iOS simulators and Android devices only. */
  screenshot: {
    params: { session: string; out?: string };
    result: { path: string };
  };
  /**
   * Block until a session reaches a state, instead of polling `logs`.
   *
   * Throws (rather than resolving `met: false`) on a timeout, or the moment the
   * condition becomes impossible -- e.g. `until: 'running'` on a session that
   * just failed. See `src/daemon/waiter.ts`.
   */
  wait: {
    params: { session: string; until: WaitUntil; timeoutMs?: number };
    result: { met: true; status: SessionStatus; elapsedMs: number; url?: string; matchedLine?: string };
  };
  /** A cheap structured overview of one session -- status, recent errors, network counts. */
  summary: {
    params: { session: string };
    result: SessionSummary;
  };
  shutdown: {
    params: {};
    result: { stopping: boolean };
  };
};

/** Server-pushed messages, sent unsolicited over the WebSocket. */
export type PushEvent =
  | { event: 'hello'; sessions: SessionSnapshot[] }
  | { event: 'session'; snapshot: SessionSnapshot }
  | { event: 'log'; sessionId: string; text: string; error: boolean }
  /** One captured HTTP request, pushed as it starts and again as it finishes. */
  | { event: 'network'; sessionId: string; request: NetworkRequestSnapshot }
  | { event: 'devices' };
