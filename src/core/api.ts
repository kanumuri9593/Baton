/**
 * The daemon's RPC contract, in one place.
 *
 * Types only -- nothing here runs. This is the single source of truth for what
 * a client (HUD, CLI, MCP) can ask the daemon and what it gets back, derived
 * from what `LaunchDaemon.handle()` in `../daemon/server.ts` actually reads and
 * returns. Changing the wire format means changing that switch and this file
 * together; changing only one is a bug.
 */
import type { LogLine, OperationResult, SessionSnapshot } from './types.ts';
import type { Target, TargetKind } from '../config/detect.ts';
import type { ValidationIssue } from '../config/validate.ts';
import type { Bootable } from '../daemon/simulators.ts';
import type { Device } from '../daemon/devices.ts';
import type { RunInfo } from './log-store.ts';

/** A detected target plus its pre-flight state, as sent to clients. */
export type TargetInfo = Target & { issues: ValidationIssue[] };

/** What one remembered project can run, tolerant of a project that has gone missing. */
export type ProjectInfo = {
  root: string;
  name: string;
  targets: Array<{ name: string; kind: TargetKind; source: Target['source']; issues: ValidationIssue[] }>;
  error?: string;
};

/** Outcome of a reload/restart on one session, with the diagnostics an agent needs to act on a failure. */
export type ReloadResult = { session: string } & OperationResult & { errors?: string[] };

/** Selects which running sessions a bulk operation (`reload`, `restart`, `stop`) applies to. */
export type SessionSelector = { session?: string; all?: boolean; ids?: string[] };

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
  forget: {
    params: { session: string };
    result: { forgotten: boolean };
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
  | { event: 'devices' };
