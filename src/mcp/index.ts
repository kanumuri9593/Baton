#!/usr/bin/env node
import { diagnoseSchema } from '../daemon/diagnose.ts';
import { workflowSchema } from '../daemon/workflow.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DaemonClient } from '../core/client.ts';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionSnapshot } from '../core/types.ts';
import {
  DASHBOARD_URI, MCP_APP_MIME, dashboardHtml, dashboardText, toDashboardRun, type DashboardCatalog, type DashboardState,
} from './dashboard.ts';
import { Controls } from './controls.ts';

/**
 * MCP surface over the daemon.
 *
 * This is what closes the loop for a coding agent: edit a file, hot reload, take
 * a screenshot, and see whether the change actually landed -- without a human
 * clicking anything. Every tool returns structured text so failures (a Dart
 * compile error, a dead device) are legible rather than scraped.
 */
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
) as { version: string };
const server = new McpServer({ name: 'baton', version: pkg.version });

/**
 * MCP tool hints, so a client can auto-approve what only looks and warn before
 * what throws something away. Nothing here reaches beyond this machine.
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const ACTS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

let client: DaemonClient | undefined;
async function daemon(): Promise<DaemonClient> {
  if (!client) {
    client = new DaemonClient();
    await client.connect();
  }
  return client;
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (err) {
    return fail((err as Error).message);
  }
}

server.tool(
  'diagnose',
  'Search bounded log and network evidence across projects. Defaults to errors only and 20 findings. Pass a trace ID and errorsOnly=false to follow a request across Node services. Use exact session IDs to limit scope.',
  diagnoseSchema.shape,
  READ_ONLY,
  async (params) => guarded(async () => (await daemon()).call('diagnose', params)),
);

server.tool(
  'run_workflow',
  'Launch up to eight project targets in dependency order and wait for each to become ready, in one call. Stops launching dependents on failure. Returns compact session IDs, URLs and errors; retains sessions for debugging. Use browser/device tools next to validate the actual flow. Paths must be absolute.',
  workflowSchema.shape,
  ACTS,
  async (plan) => guarded(async () => (await daemon()).call('workflowRun', plan)),
);

server.tool(
  'inspect_project',
  'Read fresh launch sources, configuration problems, nested projects and guidance file paths. Does not run commands or expose environment values. Use before choosing an environment, checkout and device; review screenshot evidence rather than treating capture as visual approval.',
  { cwd: z.string().optional() },
  READ_ONLY,
  async ({ cwd }) => guarded(async () => (await daemon()).call('inspectProject', { cwd })),
);

server.tool(
  'list_targets',
  'List everything runnable in a project: launch.json configs, package.json dev scripts, Flutter entrypoints.',
  { cwd: z.string().optional().describe('Project directory. Defaults to the daemon working directory.') },
  READ_ONLY,
  async ({ cwd }) => guarded(async () => (await daemon()).call('targets', { cwd })),
);

server.tool(
  'list_sessions',
  'List running sessions with their status, capabilities, URLs and device.',
  {},
  READ_ONLY,
  async () => guarded(async () => (await daemon()).call('sessions')),
);

server.tool(
  'list_checkouts',
  'List git checkouts this project can run from: This checkout, linked worktrees, local branches, remotes.',
  { cwd: z.string().optional().describe('Project directory. Defaults to the daemon working directory.') },
  READ_ONLY,
  async ({ cwd }) => guarded(async () => (await daemon()).call('checkouts', { cwd, fetch: true })),
);

server.tool(
  'run_target',
  'Start a target by name. Returns the new session id to use with the other tools. Optional branch or checkout runs from a git worktree without moving the current folder.',
  {
    target: z.string().describe('Target name or an unambiguous substring of it.'),
    cwd: z.string().optional(),
    deviceId: z.string().optional().describe('Force a specific device or simulator.'),
    branch: z.string().optional().describe('Git branch or remote ref to run from a Baton-owned copy. Mutually exclusive with checkout.'),
    checkout: z.string().optional().describe('Path to an existing worktree to attach. Mutually exclusive with branch.'),
  },
  ACTS,
  async ({ target, cwd, deviceId, branch, checkout }) =>
    guarded(async () => (await daemon()).call('run', { target, cwd, deviceId, branch, checkout })),
);

server.tool(
  'hot_reload',
  'Hot reload a session, keeping app state. Flutter only. Returns code 0 on success; a non-zero code carries the compile error.',
  {
    session: z.string().optional().describe('Session id. Omit with all=true.'),
    all: z.boolean().optional().describe('Reload every running session.'),
    reason: z.string().optional(),
  },
  ACTS,
  async ({ session, all, reason }) =>
    guarded(async () => (await daemon()).call('reload', { session, all, reason: reason ?? 'agent' })),
);

server.tool(
  'hot_restart',
  'Hot restart a session, dropping app state. For web dev servers and plain processes this reboots the process.',
  {
    session: z.string().optional(),
    all: z.boolean().optional(),
    reason: z.string().optional(),
  },
  ACTS,
  async ({ session, all, reason }) =>
    guarded(async () => (await daemon()).call('restart', { session, all, reason: reason ?? 'agent' })),
);

server.tool(
  'stop_session',
  'Stop one session, or every running session with all=true.',
  { session: z.string().optional(), all: z.boolean().optional() },
  DESTRUCTIVE,
  async ({ session, all }) => guarded(async () => (await daemon()).call('stop', { session, all })),
);

server.tool(
  'forget_session',
  'Remove stopped sessions from the list. Running sessions must be stopped first. Use all=true to clear every stopped session.',
  { session: z.string().optional(), all: z.boolean().optional() },
  DESTRUCTIVE,
  async ({ session, all }) =>
    guarded(async () => {
      const result = await (await daemon()).call('forget', { session, all });
      if (!result.removed.length) return all ? '(no stopped sessions)' : 'not found or still running';
      return result.removed.join('\n');
    }),
);

server.tool(
  'read_logs',
  'Read recent output from a session, newest last. Use filter to grep for an error. ' +
    'Works for a currently running session id, and for a past run (its own session id, or the ' +
    'runId from list_run_history) even after it has stopped or the daemon has restarted.',
  {
    session: z.string().describe('A live session id, or a past run\'s session id / runId.'),
    tail: z.number().optional().describe('How many lines (default 200).'),
    filter: z.string().optional().describe('Case-insensitive regular expression.'),
  },
  READ_ONLY,
  async ({ session, tail, filter }) =>
    guarded(async () => {
      const lines = await (await daemon()).call('logs', { session, tail, filter });
      return lines.map((l) => (l.error ? `[err] ${l.text}` : l.text)).join('\n') || '(no matching output)';
    }),
);

server.tool(
  'list_run_history',
  'List past and current runs persisted on disk -- survives daemon restarts. Each line is ' +
    'runId, name, status (live / exit N / ?), how long ago it started, and its log size. ' +
    'Pass a runId to read_logs to see its output.',
  {
    cwd: z.string().optional().describe('Project directory; limits the list to that project.'),
    limit: z.number().optional().describe('Maximum runs to return (default 50).'),
  },
  READ_ONLY,
  async ({ cwd, limit }) =>
    guarded(async () => {
      const runs = await (await daemon()).call('logHistory', { root: cwd, limit });
      if (!runs.length) return '(no runs recorded yet)';
      return runs
        .map((r) => {
          const status = r.live ? 'live' : r.exitCode === undefined || r.exitCode === null ? '?' : `exit ${r.exitCode}`;
          const ago = Math.round((Date.now() - r.startedAt) / 1000);
          return `${r.runId}  ${r.name}  ${status}  ${ago}s ago  ${r.sizeBytes}B`;
        })
        .join('\n');
    }),
);

/**
 * What HTTP capture can and cannot see, said the same way everywhere.
 *
 * An agent that believes this is a complete record of the app's networking will
 * chase the wrong bug when a request made through a native client does not
 * appear. Cheaper to say it in every description than to be believed wrongly.
 */
const COVERAGE =
  ' Flutter debug/profile sessions only, while the app is running. Captures dart:io HttpClient ' +
  'traffic (package:http and dio with its default adapter) — NOT cupertino_http/cronet_http ' +
  'native clients, WebSockets or raw sockets. Traffic those make is invisible here, not absent.';

server.tool(
  'list_network_requests',
  'List HTTP requests the app has made, newest last. One line each: ' +
    'id, method, status (… while in flight), duration in ms, response bytes, URI.' +
    COVERAGE,
  {
    session: z.string().describe('Session id from list_sessions.'),
    tail: z.number().optional().describe('How many requests (default 200).'),
    filter: z.string().optional().describe('Case-insensitive regular expression over "METHOD uri".'),
  },
  READ_ONLY,
  async ({ session, tail, filter }) =>
    guarded(async () => {
      const requests = await (await daemon()).call('network', { session, tail, filter });
      if (!requests.length) return '(no requests captured yet)';
      return requests
        .map((r) => {
          const status = r.error ? 'ERR' : r.inProgress ? '…' : r.statusCode ?? '?';
          const size = r.responseContentLength ?? 0;
          return `${r.id}  ${r.method}  ${status}  ${r.durationMs ?? 0}ms  ${size}B  ${r.uri}` +
            (r.error ? `  ${r.error}` : '');
        })
        .join('\n');
    }),
);

server.tool(
  'get_network_request',
  'One captured request in full: headers, timeline events, and optionally the bodies. ' +
    'Fetched from the running app, so it works only while the session is alive.' +
    COVERAGE,
  {
    session: z.string(),
    id: z.string().describe('Request id from list_network_requests (the short number works too).'),
    includeBodies: z.boolean().optional().describe('Include request and response bodies (capped at 256 KB).'),
  },
  READ_ONLY,
  async ({ session, id, includeBodies }) =>
    guarded(async () => {
      const detail = await (await daemon()).call('networkDetail', {
        session, id, maxBody: includeBodies ? undefined : 0,
      });
      const { requestBody, responseBody, ...rest } = detail;
      if (!includeBodies) return rest;
      return { ...rest, requestBody: readable(requestBody), responseBody: readable(responseBody) };
    }),
);

server.tool(
  'clear_network_requests',
  'Forget every captured request for a session, in the daemon and in the app itself. ' +
    'Useful before reproducing one specific call.',
  { session: z.string() },
  DESTRUCTIVE,
  async ({ session }) => guarded(async () => (await daemon()).call('networkClear', { session })),
);

/** A body an agent can read: the text, or an honest note that there is none to read. */
function readable(body?: { text?: string; size: number; truncated: boolean }) {
  if (!body) return undefined;
  if (body.text === undefined) return { note: `<binary, ${body.size} bytes>`, size: body.size };
  return { text: body.text, size: body.size, truncated: body.truncated };
}

server.tool(
  'read_launch_config',
  'Read a project\'s launch.json exactly as written -- comments, formatting and all -- plus the ' +
    'configurations it defines and any pre-flight problems with them. Returns file: null when the ' +
    'project has none; a file that does not parse still returns its text, with the parse errors.',
  { cwd: z.string().optional().describe('Project directory. Defaults to the daemon\'s current project.') },
  READ_ONLY,
  async ({ cwd }) =>
    guarded(async () => {
      const view = await (await daemon()).call('readLaunchConfig', { root: cwd });
      if (!view.file) return 'no launch.json in this project (neither .vscode/ nor .claude/)';
      return {
        file: view.file,
        text: view.text,
        parseErrors: view.parseErrors,
        configurations: view.configs.map((c) => c.name),
        // Only the configs that have something wrong: an agent reading this
        // needs the problems, not a wall of empty arrays.
        issues: Object.fromEntries(Object.entries(view.issues).filter(([, list]) => list.length > 0)),
      };
    }),
);

server.tool(
  'write_launch_config',
  'OVERWRITE a project\'s launch.json with the text given. The whole file is replaced, so read it ' +
    'with read_launch_config first and send the full text back, or comments and configurations you ' +
    'did not mean to touch are lost. Invalid JSONC is refused before anything is written. Returns ' +
    'the path written and any pre-flight issues in the result.',
  {
    cwd: z.string().optional().describe('Project directory. Defaults to the daemon\'s current project.'),
    text: z.string().describe('The complete file contents. JSONC: comments and trailing commas are allowed.'),
    file: z.enum(['vscode', 'claude']).optional()
      .describe('Which convention to create for a project that has neither. A project that already ' +
        'has a launch.json is written back to that same file.'),
  },
  DESTRUCTIVE,
  async ({ cwd, text, file }) =>
    guarded(async () => {
      const result = await (await daemon()).call('writeLaunchConfig', { root: cwd, text, file });
      return {
        file: result.file,
        configurations: result.configs.map((c) => c.name),
        issues: Object.fromEntries(Object.entries(result.issues).filter(([, list]) => list.length > 0)),
      };
    }),
);

server.tool(
  'list_devices',
  'List connected devices, simulators and emulators available to Flutter. Use boot_device to start one that is not running.',
  { cwd: z.string().optional() },
  READ_ONLY,
  async ({ cwd }) => guarded(async () => (await daemon()).call('devices', { cwd })),
);

server.tool(
  'set_debug_flag',
  'Toggle a framework debug flag on a running Flutter session, e.g. ext.flutter.debugPaint with {enabled: true} or ext.flutter.timeDilation with {timeDilation: 5}. Values are sent as the strings Flutter expects.',
  {
    session: z.string(),
    method: z.string().describe('Service extension name, e.g. ext.flutter.debugPaint'),
    params: z.record(z.string(), z.any()).optional(),
  },
  ACTS,
  async ({ session, method, params }) =>
    guarded(async () => (await daemon()).call('serviceExtension', { session, method, params })),
);

const VIEWPORT = z.string().optional().describe(
  'Web sessions only: phone (390x844), tablet (820x1180), desktop (1280x800, the default) or WIDTHxHEIGHT.',
);

/** The PNG itself, so the model can look at it, plus where it was saved. */
function imageResult(path: string, caption: string) {
  return {
    content: [
      { type: 'image' as const, data: readFileSync(path).toString('base64'), mimeType: 'image/png' },
      { type: 'text' as const, text: `${caption}\nsaved: ${path}` },
    ],
  };
}

server.tool(
  'screenshot',
  'Capture the screen of a running session so the visual result of a change can be checked. ' +
    'iOS simulators and Android devices capture the device screen. Web sessions (Vite, Next.js, ' +
    'Flutter web...) load their URL in a headless Chrome, Edge or Brave at the viewport given, and ' +
    'also report the page\'s console errors and failed requests. ' +
    'A capture proves an image was written, not that the UI is right: look at it.',
  {
    session: z.string(),
    out: z.string().optional().describe('Where to save the PNG. Defaults to a path under the daemon\'s state directory.'),
    viewport: VIEWPORT,
  },
  READ_ONLY,
  async ({ session, out, viewport }) => {
    try {
      const shot = await (await daemon()).call('screenshot', { session, out, viewport });
      const lines = [`screenshot of ${session}`];
      if (shot.consoleErrors?.length) lines.push('browser console errors:', ...shot.consoleErrors.map((e) => `  ${e}`));
      if (shot.failedRequests?.length) lines.push('failed requests:', ...shot.failedRequests.map((e) => `  ${e}`));
      return imageResult(shot.path, lines.join('\n'));
    } catch (err) {
      return fail(`screenshot failed: ${(err as Error).message}`);
    }
  },
);

server.tool(
  'check_change',
  'After editing code: apply the change and return the evidence in one call, instead of ' +
    'hot_reload + wait_for + read_logs + list_network_requests + screenshot. action=auto hot reloads ' +
    'Flutter, leaves web and React Native to HMR / Fast Refresh, and restarts everything else. ' +
    'Answers ok/not ok with only what is new since the call began: reload result, error lines ' +
    '(for web, including the browser console), failed requests, and a screenshot. Prefer this as ' +
    'the default step after every edit.',
  {
    session: z.string(),
    action: z.enum(['auto', 'reload', 'restart', 'none']).optional().describe('Default auto.'),
    settleMs: z.number().optional().describe('Wait after the action before collecting evidence (default 1500).'),
    screenshot: z.boolean().optional().describe('Default true.'),
    viewport: VIEWPORT,
  },
  ACTS,
  async ({ session, action, settleMs, screenshot, viewport }) => {
    try {
      const r = await (await daemon()).call('check', { session, action, settleMs, screenshot, viewport });
      const lines = [
        `${r.ok ? 'OK' : 'NOT OK'}  ${r.session}  action=${r.action}  status=${r.status}  ${r.elapsedMs}ms`,
      ];
      if (r.operation && r.operation.code !== 0) {
        lines.push(`${r.action} failed: ${r.operation.message ?? `code ${r.operation.code}`}`);
        for (const e of r.operation.errors ?? []) lines.push(`  ${e}`);
      }
      if (r.newErrors.length) lines.push(`new errors (${r.newErrors.length}):`, ...r.newErrors.map((e) => `  ${e}`));
      if (r.failedRequests.length) {
        lines.push(`failed requests (${r.failedRequests.length}):`, ...r.failedRequests.map((e) => `  ${e}`));
      }
      if (r.screenshotError) lines.push(`screenshot: ${r.screenshotError}`);
      if (r.screenshotPath) return imageResult(r.screenshotPath, lines.join('\n'));
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: !r.ok || undefined };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

const BOOT_ANSWER_MS = Number(process.env.BATON_BOOT_ANSWER_MS ?? 45000);

server.tool(
  'boot_device',
  'Boot an iOS simulator or Android emulator by name (e.g. "iPhone 17 Pro", "Pixel_8") or id, ' +
    'and wait until it is up. Returns the device id to pass to run_target as deviceId. Call with no ' +
    'name to list what can be booted.',
  {
    name: z.string().optional().describe('Device name, an unambiguous part of it, or its id.'),
    cwd: z.string().optional(),
  },
  ACTS,
  async ({ name, cwd }) =>
    guarded(async () => {
      const client = await daemon();
      const bootables = await client.call('bootables', { cwd });
      if (!name) {
        if (!bootables.length) return '(nothing to boot: no simulators or emulators found)';
        return bootables.map((b) => `${b.running ? '●' : '○'}  ${b.name}  ${b.id}`).join('\n');
      }
      const lower = name.toLowerCase();
      const match = bootables.find((b) => b.name === name || b.id === name)
        ?? bootables.find((b) => b.name.toLowerCase().includes(lower));
      if (!match) {
        throw new Error(`no bootable device matching "${name}". Available:\n` +
          bootables.map((b) => `  ${b.name}`).join('\n'));
      }
      if (match.running) return { id: match.id, name: match.name, alreadyRunning: true };
      // An Android emulator can take minutes; many MCP clients give up on a
      // tool call after 60s. Answer before that and let the boot carry on.
      const booting = client.call('boot', { id: match.id, cwd });
      booting.catch(() => undefined);
      const device = await Promise.race([
        booting,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), BOOT_ANSWER_MS).unref()),
      ]);
      if (!device) {
        return { id: match.id, name: match.name, booting: true,
          next: `still starting; call boot_device with name "${match.name}" again until it reports alreadyRunning, then use list_devices for its run id` };
      }
      return { id: device.id, name: device.name, booted: true };
    }),
);

server.tool(
  'wait_for',
  'Block until a session reaches a state. Use after run_target or hot_restart instead of polling read_logs.',
  {
    session: z.string(),
    until: z
      .union([
        z.enum(['running', 'stopped', 'url']),
        z.object({ log: z.string().describe('Case-insensitive regular expression matched against new log lines.') }),
      ])
      .default('running'),
    timeoutMs: z.number().optional().describe('Default 60000, capped at 900000 (15 minutes, enough for a first native build).'),
  },
  READ_ONLY,
  async ({ session, until, timeoutMs }) =>
    guarded(async () => (await daemon()).call('wait', { session, until, timeoutMs })),
);

server.tool(
  'session_summary',
  'Cheap structured overview -- call this before deciding what to do next.',
  { session: z.string() },
  READ_ONLY,
  async ({ session }) => guarded(async () => (await daemon()).call('summary', { session })),
);

server.tool(
  'run_proof',
  'Run proof verification and return a zip with screenshots, network call counts, response times and logs.',
  {
    target: z.string().describe('Target name or unambiguous substring.'),
    cwd: z.string().optional(),
    branch: z.string().optional().describe('Branch to verify in an isolated worktree.'),
    checkout: z.string().optional().describe('Existing worktree to verify.'),
    devices: z.string().optional().describe('Comma-separated device names, e.g. "iPhone SE,iPhone 16 Pro Max".'),
    appearance: z.string().optional().describe('Comma-separated: light,dark'),
    textScale: z.string().optional().describe('Comma-separated scales, e.g. 1.0,1.5'),
    locale: z.string().optional().describe('Comma-separated locale codes'),
    route: z.string().optional().describe('Deep link or URL to open on each device before capture.'),
    checks: z.string().optional().describe('Comma-separated checks: running,noErrors,noFailedRequests,screenshot'),
    allow: z.string().optional().describe('Comma-separated regexes allowed in noErrors check.'),
    keep: z.boolean().optional().describe('Leave sessions running after the proof.'),
    out: z.string().optional().describe('Bundle output directory.'),
    settleMs: z.number().optional().describe('Milliseconds to wait after navigation before screenshot (default 2000).'),
    timeoutMs: z.number().optional().describe('Per-cell running timeout (default 120000).'),
  },
  ACTS,
  async (params) =>
    guarded(async () => {
      const checks = params.checks?.split(',').map((c) => c.trim()).filter(Boolean);
      const allow = params.allow?.split(',').map((c) => c.trim()).filter(Boolean);
      const devices = params.devices?.split(',').map((c) => c.trim()).filter(Boolean);
      const appearance = params.appearance?.split(',').map((c) => c.trim()).filter(Boolean) as ('light' | 'dark')[] | undefined;
      const textScale = params.textScale?.split(',').map((c) => Number(c.trim())).filter((n) => Number.isFinite(n));
      const locale = params.locale?.split(',').map((c) => c.trim()).filter(Boolean);
      const result = await (await daemon()).call('proofRun', {
        target: params.target,
        cwd: params.cwd,
        branch: params.branch,
        checkout: params.checkout,
        devices: devices?.length ? devices : undefined,
        appearance: appearance?.length ? appearance : undefined,
        textScale: textScale?.length ? textScale : undefined,
        locale: locale?.length ? locale : undefined,
        route: params.route,
        checks: checks?.length ? checks as any : undefined,
        allow: allow?.length ? allow : undefined,
        keep: params.keep,
        out: params.out,
        settleMs: params.settleMs,
        timeoutMs: params.timeoutMs,
      });
      const summaryPath = `${result.bundlePath}/summary.md`;
      const summaryText = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : JSON.stringify(result, null, 2);
      const zipLine = result.zipPath ? `\nzip: ${result.zipPath}` : `\nbundle: ${result.bundlePath}`;
      return `${summaryText}${zipLine}`;
    }),
);

server.tool(
  'list_proofs',
  'List past proof bundles, newest first.',
  { limit: z.number().optional().describe('Maximum entries (default 20).') },
  READ_ONLY,
  async ({ limit }) =>
    guarded(async () => {
      const proofs = await (await daemon()).call('proofList', { limit: limit ?? 20 });
      if (!proofs.length) return '(no proofs yet)';
      return proofs
        .map((p) => {
          const where = p.zipPath ?? p.bundlePath;
          return `${p.passed ? 'PASS' : 'FAIL'}  ${p.id}  ${p.target}  ${p.cellCount} cells  ${where}`;
        })
        .join('\n');
    }),
);

// --- Live card in chat hosts that draw MCP Apps (the Claude app, claude.ai) ---

const devicesByTarget = new Map<string, string>();
const controls = new Controls();
async function dashboardState(extra: Partial<DashboardState> = {}): Promise<DashboardState> {
  const d = await daemon();
  const sessions = (await d.call('sessions')) as SessionSnapshot[];
  const unknown = sessions.some((s) => s.target && !devicesByTarget.has(s.target));
  if (unknown) {
    for (const cwd of [...new Set(sessions.map((s) => s.root).filter((r): r is string => !!r))].slice(0, 4)) {
      try {
        for (const dev of (await d.call('devices', { cwd })) as Array<{ id: string; name: string }>) {
          devicesByTarget.set(dev.id, dev.name);
        }
      } catch {
        // A project without device tooling shows its URL instead.
      }
    }
  }
  const paused = controls.pausedIds(sessions);
  const runs = sessions.map((s) => toDashboardRun(s, devicesByTarget, {
    paused: paused.has(s.id),
    canPause: controls.canPause(s),
    canFront: controls.canFront(s),
  }));
  return { runs, at: Date.now(), ...extra };
}

/** Settle within `ms`: a card waiting on slow device discovery would look frozen. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/** Projects Baton knows with what each can run, and every simulator or emulator it can run on or boot. */
async function dashboardCatalog(): Promise<DashboardCatalog> {
  const d = await daemon();
  const { projects } = (await d.call('projects', {})) as { projects: Array<{ root: string; name: string; targets?: Array<{ name: string; kind: string }> }> };
  const devices = new Map<string, DashboardCatalog['devices'][number]>();
  const platform = (p: string) => (/ios/i.test(p) ? 'ios' : /android/i.test(p) ? 'android' : 'other') as 'ios' | 'android' | 'other';
  const cwd = projects[0]?.root;
  // Both lists are best-effort: without Flutter or Xcode they can be slow or
  // fail, and the form still works for targets that need no device.
  type Live = Array<{ id: string; name: string; platformType?: string; platform?: string }>;
  type Boot = Array<{ id: string; name: string; platformType: 'ios' | 'android'; running: boolean; runtime?: string }>;
  const [live, bootable] = await Promise.all([
    within(d.call('devices', { cwd }) as Promise<Live>, 6000, [] as Live),
    within(d.call('bootables', { cwd }) as Promise<Boot>, 6000, [] as Boot),
  ]);
  for (const dev of live) {
    devicesByTarget.set(dev.id, dev.name);
    devices.set(dev.id, { id: dev.id, name: dev.name, platform: platform(dev.platformType ?? dev.platform ?? ''), running: true });
  }
  for (const b of bootable) {
    if (devices.has(b.id)) continue;
    devices.set(b.id, { id: b.id, name: b.name, platform: b.platformType, running: b.running, runtime: b.runtime });
  }
  return {
    projects: projects
      .filter((p) => (p.targets ?? []).length > 0)
      .map((p) => ({ root: p.root, name: p.name, targets: (p.targets ?? []).map((t) => ({ name: t.name, kind: t.kind })) })),
    devices: [...devices.values()].sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name)),
  };
}

function card(state: DashboardState) {
  return {
    content: [{ type: 'text' as const, text: dashboardText(state) }],
    structuredContent: state as unknown as Record<string, unknown>,
  };
}

server.registerResource(
  'baton-dashboard',
  DASHBOARD_URI,
  { title: 'Baton', description: 'Live Baton control panel: start, pause, reload, restart, logs, screenshots and stop.', mimeType: MCP_APP_MIME },
  async () => ({ contents: [{ uri: DASHBOARD_URI, mimeType: MCP_APP_MIME, text: dashboardHtml(pkg.version) }] }),
);

server.registerTool(
  'show_dashboard',
  {
    title: 'Show Baton',
    description:
      'Show a live Baton control panel in the chat: every running app with its simulator or URL, status, CPU and memory; ' +
      'per-app Reload, Restart, Pause/Resume, Bring to front, Logs, Screenshot and Stop; quick actions for all apps; ' +
      'and New run (pick a project, target and device, or boot a simulator). Use when the user asks to see or show Baton, their runs or simulators.',
    inputSchema: {},
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: DASHBOARD_URI }, 'ui/resourceUri': DASHBOARD_URI },
  },
  async () => {
    try {
      const state = await dashboardState();
      // The card still shows runs without it; New run asks again when opened.
      const catalog = await within(dashboardCatalog(), 3000, undefined);
      if (catalog) state.catalog = catalog;
      return card(state);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

const DASHBOARD_ACTIONS = [
  'refresh', 'catalog', 'run', 'boot', 'logs',
  'reload', 'restart', 'pause', 'resume', 'front', 'screenshot', 'stop', 'dismiss',
  'reload_all', 'restart_all', 'pause_all', 'resume_all', 'front_all', 'stop_all',
] as const;

server.registerTool(
  'dashboard_action',
  {
    title: 'Baton card action',
    description:
      'Used by the Baton card: refresh; catalog (projects and devices for New run); run a project target on a device; boot a device; ' +
      'logs, reload, restart, pause, resume, front, screenshot, stop or dismiss (forget a finished run) one session; or reload/restart/pause/resume/front/stop all. Returns the card state.',
    inputSchema: {
      action: z.enum(DASHBOARD_ACTIONS),
      session: z.string().optional(),
      root: z.string().optional(),
      target: z.string().optional(),
      device: z.string().optional(),
    },
    annotations: DESTRUCTIVE,
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ['app'] } },
  },
  async ({ action, session, root, target, device }) => {
    try {
      const d = await daemon();
      const runs = (await d.call('sessions')) as SessionSnapshot[];
      const one = () => {
        const s = runs.find((r) => r.id === session);
        if (!s) throw new Error(session ? `no run ${session}` : `${action} needs a session`);
        return s;
      };
      const live = runs.filter((s) => s.status === 'running');
      let message: string | undefined;
      const extra: Partial<DashboardState> = {};
      const failures = (results: Array<{ code: number; message?: string }>) => {
        const failed = results.find((r) => r.code !== 0);
        if (failed) message = failed.message ?? `${action} failed`;
      };

      switch (action) {
        case 'refresh':
          break;
        case 'catalog':
          extra.catalog = await dashboardCatalog();
          break;
        case 'run': {
          if (!root || !target) throw new Error('run needs a project and a target');
          await d.call('run', { cwd: root, target, deviceId: device || undefined });
          break;
        }
        case 'boot': {
          if (!device) throw new Error('boot needs a device');
          await d.call('boot', { id: device });
          extra.catalog = await dashboardCatalog();
          break;
        }
        case 'logs': {
          const s = one();
          const lines = (await d.call('logs', { session: s.id, tail: 80 })) as Array<{ text: string; error: boolean }>;
          extra.logs = { session: s.id, name: s.name, lines: lines.map((l) => ({ text: l.text, error: l.error })) };
          break;
        }
        case 'reload':
        case 'restart':
          failures((await d.call(action, { session: one().id, reason: 'Baton card' })) as Array<{ code: number; message?: string }>);
          break;
        case 'pause':
          controls.pause(one());
          break;
        case 'resume':
          controls.resume(one());
          break;
        case 'front':
          controls.front(one());
          break;
        case 'stop':
          await d.call('stop', { session: one().id });
          break;
        case 'dismiss':
          await d.call('forget', { session: one().id });
          break;
        case 'screenshot': {
          const s = one();
          const { path } = (await d.call('screenshot', { session: s.id })) as { path: string };
          extra.shot = { session: s.id, name: s.name, dataUrl: `data:image/png;base64,${readFileSync(path).toString('base64')}` };
          break;
        }
        case 'reload_all': {
          const ids = live.filter((s) => s.capabilities.includes('hotReload')).map((s) => s.id);
          if (ids.length) failures((await d.call('reload', { ids, reason: 'Baton card' })) as Array<{ code: number; message?: string }>);
          break;
        }
        case 'restart_all': {
          const ids = live.filter((s) => s.capabilities.includes('hotRestart') || s.capabilities.includes('restartProcess')).map((s) => s.id);
          if (ids.length) failures((await d.call('restart', { ids, reason: 'Baton card' })) as Array<{ code: number; message?: string }>);
          break;
        }
        case 'pause_all':
        case 'resume_all': {
          const paused = controls.pausedIds(live);
          const errors: string[] = [];
          for (const s of live.filter((r) => controls.canPause(r) && paused.has(r.id) === (action === 'resume_all'))) {
            try {
              if (action === 'pause_all') controls.pause(s); else controls.resume(s);
            } catch (err) {
              errors.push((err as Error).message);
            }
          }
          if (errors.length) message = errors.join('; ');
          break;
        }
        case 'front_all': {
          const sims = live.filter((s) => controls.isSimulator(s) && controls.canFront(s));
          if (sims[0]) controls.front(sims[0]);
          for (const s of live.filter((r) => !controls.isSimulator(r) && controls.canFront(r))) controls.front(s);
          break;
        }
        case 'stop_all': {
          const ids = runs.filter((s) => s.status === 'running' || s.status === 'starting').map((s) => s.id);
          if (ids.length) await d.call('stop', { ids });
          break;
        }
      }
      return card(await dashboardState({ message, ...extra }));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());
