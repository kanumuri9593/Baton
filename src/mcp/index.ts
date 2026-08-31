#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DaemonClient } from '../core/client.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';

const run = promisify(execFile);

/**
 * MCP surface over the daemon.
 *
 * This is what closes the loop for a coding agent: edit a file, hot reload, take
 * a screenshot, and see whether the change actually landed -- without a human
 * clicking anything. Every tool returns structured text so failures (a Dart
 * compile error, a dead device) are legible rather than scraped.
 */
const server = new McpServer({ name: 'baton', version: '0.1.0' });

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
  'list_targets',
  'List everything runnable in a project: launch.json configs, package.json dev scripts, Flutter entrypoints.',
  { cwd: z.string().optional().describe('Project directory. Defaults to the daemon working directory.') },
  async ({ cwd }) => guarded(async () => (await daemon()).call('targets', { cwd })),
);

server.tool(
  'list_sessions',
  'List running sessions with their status, capabilities, URLs and device.',
  {},
  async () => guarded(async () => (await daemon()).call('sessions')),
);

server.tool(
  'run_target',
  'Start a target by name. Returns the new session id to use with the other tools.',
  {
    target: z.string().describe('Target name or an unambiguous substring of it.'),
    cwd: z.string().optional(),
    deviceId: z.string().optional().describe('Force a specific device or simulator.'),
  },
  async ({ target, cwd, deviceId }) =>
    guarded(async () => (await daemon()).call('run', { target, cwd, deviceId })),
);

server.tool(
  'hot_reload',
  'Hot reload a session, keeping app state. Flutter only. Returns code 0 on success; a non-zero code carries the compile error.',
  {
    session: z.string().optional().describe('Session id. Omit with all=true.'),
    all: z.boolean().optional().describe('Reload every running session.'),
    reason: z.string().optional(),
  },
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
  async ({ session, all, reason }) =>
    guarded(async () => (await daemon()).call('restart', { session, all, reason: reason ?? 'agent' })),
);

server.tool(
  'stop_session',
  'Stop one session, or every running session with all=true.',
  { session: z.string().optional(), all: z.boolean().optional() },
  async ({ session, all }) => guarded(async () => (await daemon()).call('stop', { session, all })),
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
  async ({ session }) => guarded(async () => (await daemon()).call('networkClear', { session })),
);

/** A body an agent can read: the text, or an honest note that there is none to read. */
function readable(body?: { text?: string; size: number; truncated: boolean }) {
  if (!body) return undefined;
  if (body.text === undefined) return { note: `<binary, ${body.size} bytes>`, size: body.size };
  return { text: body.text, size: body.size, truncated: body.truncated };
}

server.tool(
  'list_devices',
  'List connected devices, simulators and emulators available to Flutter.',
  { cwd: z.string().optional() },
  async ({ cwd }) => guarded(async () => (await daemon()).call('devices', { cwd })),
);

server.tool(
  'set_debug_flag',
  'Toggle a framework debug flag on a running Flutter session, e.g. ext.flutter.debugPaint or ext.flutter.timeDilation.',
  {
    session: z.string(),
    method: z.string().describe('Service extension name, e.g. ext.flutter.debugPaint'),
    params: z.record(z.string(), z.any()).optional(),
  },
  async ({ session, method, params }) =>
    guarded(async () => (await daemon()).call('serviceExtension', { session, method, params })),
);

server.tool(
  'screenshot',
  'Capture the screen of a running session so the visual result of a change can be checked. Supports iOS simulators and Android devices.',
  { session: z.string() },
  async ({ session }) => {
    try {
      const sessions = await (await daemon()).call('sessions');
      const found = sessions.find((s) => s.id === session || s.id.startsWith(session));
      if (!found) return fail(`no session matching "${session}"`);
      if (!found.target) return fail(`session ${found.id} has no capturable device`);

      const path = join(tmpdir(), `baton-${found.id.replace(/[^a-z0-9]/gi, '_')}.png`);

      if (/^[0-9A-F-]{36}$/i.test(found.target)) {
        await run('xcrun', ['simctl', 'io', found.target, 'screenshot', path]);
      } else if (found.target.startsWith('emulator-') || /^[A-Z0-9]{6,}$/i.test(found.target)) {
        await run('adb', ['-s', found.target, 'exec-out', 'screencap', '-p'], {
          encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
        }).then((r: any) => writeFileSync(path, r.stdout));
      } else {
        return fail(`screenshots are not supported for target "${found.target}"`);
      }

      return {
        content: [
          { type: 'image' as const, data: readFileSync(path).toString('base64'), mimeType: 'image/png' },
        ],
      };
    } catch (err) {
      return fail(`screenshot failed: ${(err as Error).message}`);
    }
  },
);

await server.connect(new StdioServerTransport());
