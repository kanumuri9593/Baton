import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { SessionRegistry } from '../core/registry.ts';
import { detectTargets, findProjectRoot } from '../config/detect.ts';
import { validate } from '../config/validate.ts';
import { ProjectRegistry } from '../core/projects.ts';
import { handshakePath } from '../core/paths.ts';
import { renderHud } from '../hud/render.ts';
import type { Capability } from '../core/types.ts';

export type Handshake = { port: number; token: string; pid: number; version: string };

export type RpcRequest = { id?: number; method: string; params?: Record<string, any> };

/**
 * The one long-lived process that owns every session.
 *
 * Clients (HUD, CLI, MCP) are all thin and stateless: they connect, call methods
 * and render. That is what lets a session started from a terminal outlive the
 * terminal, and be controlled from a floating window or an agent at the same time.
 */
export class LaunchDaemon {
  readonly registry = new SessionRegistry();
  readonly projects = new ProjectRegistry();
  #wss?: WebSocketServer;
  #http = createServer((req, res) => this.#handleHttp(req, res));
  #clients = new Set<WebSocket>();
  #token = randomBytes(24).toString('hex');
  #version: string;

  constructor(version = '0.1.0') {
    this.#version = version;
    this.registry.on('change', (snapshot) => this.#broadcast({ event: 'session', snapshot }));
    this.registry.on('log', (sessionId, text, error) =>
      this.#broadcast({ event: 'log', sessionId, text, error }),
    );
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<Handshake> {
    // Reject unauthorised clients during the upgrade, before a socket exists.
    // Accepting first and closing after leaves a window in which an unauthorised
    // client is genuinely connected and can send frames.
    this.#wss = new WebSocketServer({
      server: this.#http,
      verifyClient: ({ req }, done) => {
        if (this.#authorised(req.url, req.headers)) done(true);
        else done(false, 401, 'unauthorised');
      },
    });
    this.#wss.on('connection', (socket, req) => this.#handleSocket(socket, req));

    await new Promise<void>((resolve) => this.#http.listen(port, host, resolve));
    const address = this.#http.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;

    const handshake: Handshake = {
      port: actualPort, token: this.#token, pid: process.pid, version: this.#version,
    };
    // 0600: the token is a local capability, not a secret worth sharing.
    writeFileSync(handshakePath(), JSON.stringify(handshake, null, 2), { mode: 0o600 });
    return handshake;
  }

  async close(): Promise<void> {
    await this.registry.stopAll();
    for (const client of this.#clients) client.close();
    this.#wss?.close();
    // `close()` alone waits for idle keep-alive sockets to time out, which makes
    // shutdown appear to hang. Drop them explicitly.
    this.#http.closeAllConnections?.();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
    try { rmSync(handshakePath()); } catch { /* already gone */ }
  }

  // --- transport ---

  #authorised(url: string | undefined, headers: IncomingMessage['headers']): boolean {
    const bearer = headers.authorization?.replace(/^Bearer\s+/i, '');
    if (bearer === this.#token) return true;
    const token = new URL(url ?? '/', 'http://localhost').searchParams.get('token');
    return token === this.#token;
  }

  #handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // The HUD is served unauthenticated because it is bound to loopback and
    // ships the token to the page itself; the token still guards the socket.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderHud(this.#token));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: this.#version, pid: process.pid }));
      return;
    }
    res.writeHead(404).end('not found');
  }

  #handleSocket(socket: WebSocket, _req: IncomingMessage): void {
    // Authorisation already happened in verifyClient; reaching here means allowed.
    this.#clients.add(socket);
    socket.on('close', () => this.#clients.delete(socket));
    socket.on('message', async (raw) => {
      let request: RpcRequest;
      try {
        request = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ error: 'malformed request' }));
        return;
      }
      try {
        const result = await this.handle(request);
        socket.send(JSON.stringify({ id: request.id, result }));
      } catch (err) {
        socket.send(JSON.stringify({ id: request.id, error: (err as Error).message }));
      }
    });

    socket.send(JSON.stringify({ event: 'hello', sessions: this.registry.snapshots() }));
  }

  #broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of this.#clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  // --- methods ---

  /** Dispatch one RPC. Exposed directly so tests can call it without a socket. */
  async handle(request: RpcRequest): Promise<unknown> {
    const p = request.params ?? {};

    switch (request.method) {
      case 'targets': {
        const root = this.#resolveRoot(p.cwd);
        if (p.cwd) this.projects.remember(root);
        const targets = detectTargets(root).map((target) => ({
          ...target,
          issues: target.config ? validate(target.config) : [],
        }));
        // `projects` lets a client with no cwd of its own offer a switcher.
        return { root, targets, projects: this.projects.list() };
      }

      case 'useProject': {
        const root = findProjectRoot(p.root);
        this.projects.remember(root);
        return { root };
      }

      case 'sessions':
        return this.registry.snapshots();

      case 'devices': {
        const root = this.#resolveRoot(p.cwd);
        const devices = this.registry.devices(root);
        await devices.ready();
        return devices.list();
      }

      case 'run': {
        const root = this.#resolveRoot(p.cwd);
        this.projects.remember(root);
        const targets = detectTargets(root);
        const target = matchTarget(targets, p.target);
        if (!target) {
          throw new Error(
            `no target matching "${p.target}" in ${root}. Run \`clilaunch list\` to see what is available.`,
          );
        }
        // Fail before spawning: a missing dart-define file surfaces deep inside
        // the build otherwise, long after the useful context is gone.
        const issues = target.config ? validate(target.config) : [];
        if (issues.length > 0 && !p.force) {
          throw new Error(
            `"${target.name}" cannot run yet:\n` +
              issues.map((i) => `  missing ${i.path} — ${i.hint}`).join('\n'),
          );
        }

        const session = await this.registry.run(target, { deviceId: p.deviceId });
        return session.snapshot();
      }

      case 'reload':
      case 'restart': {
        const full = request.method === 'restart';
        const sessions = this.#select(p);
        const results = await Promise.all(
          sessions.map(async (s) => {
            try {
              const result = full
                ? await s.hotRestart(p.reason)
                : await s.hotReload(p.reason);
              // A failed reload reports only a summary ("DevFS synchronization
              // failed"). The actionable part -- file, line, message -- is in the
              // log stream, so attach it: an agent that broke the build needs the
              // error itself, not a category.
              if (result.code !== 0) {
                return { session: s.id, ...result, errors: recentErrors(s) };
              }
              return { session: s.id, ...result };
            } catch (err) {
              return { session: s.id, code: 1, message: (err as Error).message };
            }
          }),
        );
        return results;
      }

      case 'stop': {
        const sessions = this.#select(p);
        await Promise.allSettled(sessions.map((s) => s.stop()));
        return sessions.map((s) => s.snapshot());
      }

      case 'logs': {
        const session = this.#require(p.session);
        const lines = session.recentLogs(p.tail ?? 200);
        const filtered = p.filter
          ? lines.filter((l) => new RegExp(p.filter, 'i').test(l.text))
          : lines;
        return filtered;
      }

      case 'serviceExtension': {
        const session = this.#require(p.session);
        if (!session.capabilities.has('serviceExtension' as Capability)) {
          throw new Error(`${session.kind} sessions have no service extensions`);
        }
        return (session as any).callServiceExtension(p.method, p.params ?? {});
      }

      case 'forget':
        return { forgotten: this.registry.forget(p.session) };

      case 'shutdown':
        setTimeout(() => this.close().then(() => process.exit(0)), 50);
        return { stopping: true };

      default:
        throw new Error(`unknown method: ${request.method}`);
    }
  }

  /**
   * Which project a call refers to.
   *
   * An explicit cwd always wins. Otherwise fall back to the most recently used
   * project rather than the daemon's own directory, which is meaningless.
   */
  #resolveRoot(cwd?: string | null): string {
    if (cwd) return findProjectRoot(cwd);
    return this.projects.active() ?? findProjectRoot(process.cwd());
  }

  #require(id: string) {
    const session = this.registry.get(id);
    if (!session) throw new Error(`no session matching "${id}"`);
    return session;
  }

  /** `{all: true}` targets every live session; otherwise one named session. */
  #select(p: Record<string, any>) {
    if (p.all) {
      return this.registry.list().filter((s) => s.status === 'running');
    }
    return [this.#require(p.session)];
  }
}

/**
 * Pull the compiler diagnostics out of a session's recent output.
 *
 * Matches the shapes the major toolchains print: `path:line:col: Error: ...`
 * (Dart, TypeScript, Rust) and bare `Error:` / `error TS1234:` lines.
 */
function recentErrors(session: { recentLogs: (n?: number) => { text: string; error: boolean }[] }): string[] {
  const DIAGNOSTIC = /(^|\s)(\S+\.\w+:\d+:\d+:|error(\s+\w+\d+)?:|Error:|Failed to compile)/i;
  return session
    .recentLogs(200)
    .filter((line) => line.error || DIAGNOSTIC.test(line.text))
    .map((line) => line.text)
    .slice(-25);
}

/** Match a target by exact name, then case-insensitive substring. */
export function matchTarget<T extends { name: string }>(targets: T[], query: string): T | undefined {
  if (!query) return undefined;
  const exact = targets.find((t) => t.name === query);
  if (exact) return exact;
  const lower = query.toLowerCase();
  const matches = targets.filter((t) => t.name.toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0] : matches[0];
}

/** Read the handshake left by a running daemon, if there is one. */
export function readHandshake(): Handshake | undefined {
  const path = handshakePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Handshake;
  } catch {
    return undefined;
  }
}
