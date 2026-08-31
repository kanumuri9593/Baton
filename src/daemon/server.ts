import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { SessionRegistry } from '../core/registry.ts';
import { detectTargets, findProjectRoot, isProjectRoot } from '../config/detect.ts';
import { validate } from '../config/validate.ts';
import { ProjectRegistry } from '../core/projects.ts';
import { handshakePath, sessionLogDir } from '../core/paths.ts';
import { renderHud, HUD_ASSETS } from '../hud/render.ts';
import { LogHistory, safe } from '../core/log-store.ts';
import { LogSink } from './log-sink.ts';
import { NetworkStore } from '../core/network-store.ts';
import { NetworkService, type CreateVmClient } from './network.ts';
import type { Capability, Session } from '../core/types.ts';
import type { ProjectInfo, PushEvent, RpcMethods, TargetInfo } from '../core/api.ts';

export type LaunchDaemonOptions = {
  /** Injectable for tests; defaults to a real store rooted at `stateDir()`. */
  history?: LogHistory;
  /** How network capture opens a VM service connection; injected in tests. */
  createClient?: CreateVmClient;
  /** How often capture polls the app's HTTP profile. Tests use a few milliseconds. */
  networkPollIntervalMs?: number;
};

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
  readonly history: LogHistory;
  readonly network: NetworkService;
  #logSink: LogSink;
  #wss?: WebSocketServer;
  #http = createServer((req, res) => this.#handleHttp(req, res));
  #clients = new Set<WebSocket>();
  #token = randomBytes(24).toString('hex');
  #version: string;

  constructor(version = '0.1.0', options: LaunchDaemonOptions = {}) {
    this.#version = version;
    this.history = options.history ?? new LogHistory(sessionLogDir());
    this.#logSink = new LogSink(this.registry, this.history);
    this.network = new NetworkService(
      this.registry,
      new NetworkStore(),
      options.createClient,
      { pollIntervalMs: options.networkPollIntervalMs },
    );
    this.registry.on('change', (snapshot) => this.#broadcast({ event: 'session', snapshot } satisfies PushEvent));
    this.registry.on('log', (sessionId, text, error) =>
      this.#broadcast({ event: 'log', sessionId, text, error } satisfies PushEvent),
    );
    // Every captured request, pushed as it happens -- the HUD's network pane and
    // `baton network -f` both live on this rather than polling the daemon.
    this.network.store.on('request', (sessionId: string, request) =>
      this.#broadcast({ event: 'network', sessionId, request } satisfies PushEvent),
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
    this.network.disposeAll();
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
    // no-store so a reload after an upgrade never shows a stale page.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderHud(this.#token));
      return;
    }
    // The HUD's own CSS/JS, looked up in a fixed allowlist rather than joined
    // onto a filesystem path -- a name that is not one of the known assets
    // (including any `..` traversal attempt) simply isn't in the map and
    // falls through to the generic 404 below.
    if (url.pathname.startsWith('/assets/')) {
      const asset = HUD_ASSETS.get(url.pathname.slice('/assets/'.length));
      if (asset) {
        res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-store' });
        res.end(readFileSync(asset.path));
      } else {
        res.writeHead(404).end('not found');
      }
      return;
    }
    // A plain request/response door into the same methods. The macOS menu-bar
    // app, a shell script and `curl` all speak HTTP without a WebSocket client;
    // requiring one would make the daemon harder to build on top of.
    if (url.pathname === '/rpc' && req.method === 'POST') {
      if (!this.#authorised(req.url, req.headers)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorised"}');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on('end', async () => {
        res.setHeader('content-type', 'application/json');
        try {
          const result = await this.handle(JSON.parse(body || '{}'));
          res.writeHead(200).end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(400).end(JSON.stringify({ error: (err as Error).message }));
        }
      });
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

    socket.send(JSON.stringify({ event: 'hello', sessions: this.registry.snapshots() } satisfies PushEvent));
  }

  #broadcast(message: PushEvent): void {
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
        const params = p as RpcMethods['targets']['params'];
        const root = this.#resolveRoot(params.cwd);
        if (params.cwd) this.projects.remember(root);
        const targets: TargetInfo[] = detectTargets(root).map((target) => ({
          ...target,
          issues: target.config ? validate(target.config) : [],
        }));
        // `projects` lets a client with no cwd of its own offer a switcher.
        return { root, targets, projects: this.projects.list() } satisfies RpcMethods['targets']['result'];
      }

      case 'projects': {
        // Every remembered project with what it can run, so the HUD can show
        // three projects at once instead of making you switch between them.
        // With nothing remembered yet, offer the best guess rather than an empty
        // list: a HUD that shows no projects at all looks broken.
        const params = p as RpcMethods['projects']['params'];
        const roots = this.projects.list();
        if (roots.length === 0) roots.push(this.#resolveRoot(params.cwd));
        return {
          active: this.projects.active() ?? roots[0],
          projects: roots.map((root) => this.#describeProject(root)),
        } satisfies RpcMethods['projects']['result'];
      }

      case 'addProject': {
        const params = p as RpcMethods['addProject']['params'];
        const raw = String(params.path ?? '').trim();
        if (!raw) throw new Error('which directory?');
        const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
        const path = resolve(expanded);
        if (!existsSync(path) || !statSync(path).isDirectory()) {
          throw new Error(`not a directory: ${path}`);
        }
        const root = findProjectRoot(path);
        // A project with nothing runnable yet is still worth tracking -- a dev
        // script may appear tomorrow. A directory that is not a project at all
        // is almost always a typo, so that is what gets rejected.
        if (!isProjectRoot(root)) {
          throw new Error(
            `${root} does not look like a project — no package.json, pubspec.yaml, .vscode or .git`,
          );
        }
        const described = this.#describeProject(root);
        this.projects.remember(root);
        return described satisfies RpcMethods['addProject']['result'];
      }

      case 'removeProject': {
        const params = p as RpcMethods['removeProject']['params'];
        return { removed: this.projects.forget(String(params.root ?? '')) } satisfies RpcMethods['removeProject']['result'];
      }

      case 'bootables': {
        const params = p as RpcMethods['bootables']['params'];
        const devices = this.registry.devices(this.#deviceRoot(params.cwd));
        await devices.ready(500);
        return devices.bootables() satisfies Promise<RpcMethods['bootables']['result']>;
      }

      case 'boot': {
        const params = p as RpcMethods['boot']['params'];
        const device = await this.registry.devices(this.#deviceRoot(params.cwd)).boot(String(params.id));
        this.#broadcast({ event: 'devices' } satisfies PushEvent);
        return device satisfies RpcMethods['boot']['result'];
      }

      case 'useProject': {
        const params = p as RpcMethods['useProject']['params'];
        const root = findProjectRoot(params.root);
        this.projects.remember(root);
        return { root } satisfies RpcMethods['useProject']['result'];
      }

      case 'sessions':
        return this.registry.snapshots() satisfies RpcMethods['sessions']['result'];

      case 'devices': {
        const params = p as RpcMethods['devices']['params'];
        const devices = this.registry.devices(this.#deviceRoot(params.cwd));
        await devices.ready();
        return devices.list() satisfies RpcMethods['devices']['result'];
      }

      case 'run': {
        const params = p as RpcMethods['run']['params'];
        const root = this.#resolveRoot(params.cwd);
        this.projects.remember(root);
        const targets = detectTargets(root);
        const target = matchTarget(targets, params.target);
        if (!target) {
          const candidates = matchCandidates(targets, params.target);
          if (candidates.length > 1) {
            throw new Error(
              `"${params.target}" matches several targets: ${candidates.map((c) => c.name).join(', ')}. Use the full name.`,
            );
          }
          throw new Error(
            `no target matching "${params.target}" in ${root}. Run \`baton list\` to see what is available.`,
          );
        }
        // Fail before spawning: a missing dart-define file surfaces deep inside
        // the build otherwise, long after the useful context is gone.
        const issues = target.config ? validate(target.config) : [];
        if (issues.length > 0 && !params.force) {
          throw new Error(
            `"${target.name}" cannot run yet:\n` +
              issues.map((i) => `  missing ${i.path} — ${i.hint}`).join('\n'),
          );
        }

        const session = await this.registry.run(target, { deviceId: params.deviceId });
        return session.snapshot() satisfies RpcMethods['run']['result'];
      }

      case 'reload':
      case 'restart': {
        const params = p as RpcMethods['reload']['params'];
        const full = request.method === 'restart';
        const sessions = this.#select(p);
        const results = await Promise.all(
          sessions.map(async (s) => {
            try {
              const result = full
                ? await s.hotRestart(params.reason)
                : await s.hotReload(params.reason);
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
        return results satisfies RpcMethods['reload']['result'];
      }

      case 'stop': {
        const sessions = this.#select(p);
        await Promise.allSettled(sessions.map((s) => s.stop()));
        return sessions.map((s) => s.snapshot()) satisfies RpcMethods['stop']['result'];
      }

      case 'logs': {
        const params = p as RpcMethods['logs']['params'];
        // A live session always wins; fall back to disk so `baton logs <id>`
        // keeps working once the session (or a whole daemon restart) is gone.
        let session;
        try {
          session = this.#require(params.session);
        } catch (err) {
          if (this.history.has(params.session)) {
            const fromDisk = this.history.read(params.session, { tail: params.tail, filter: params.filter });
            return fromDisk satisfies RpcMethods['logs']['result'];
          }
          throw err;
        }
        const lines = session.recentLogs(params.tail ?? 200);
        const filtered = params.filter
          ? lines.filter((l) => new RegExp(params.filter!, 'i').test(l.text))
          : lines;
        return filtered satisfies RpcMethods['logs']['result'];
      }

      case 'logHistory': {
        const params = p as RpcMethods['logHistory']['params'];
        const limit = params.limit ?? 50;
        // Like every other cwd/root-taking RPC (`targets`, `bootables`, ...),
        // normalise to the actual project root before filtering -- a
        // subdirectory of a project (which is all `params.root` is when it
        // comes from an MCP `cwd`) must match, not just an exact root string.
        const root = params.root ? findProjectRoot(params.root) : undefined;
        const fromDisk = this.history.list(root);
        const live = new Map(fromDisk.map((r) => [r.runId, r] as const));
        // Overlay live sessions on top: their size on disk lags behind what is
        // actually in the ring, and a run that has not exited yet has nothing
        // for `list()` to scrape an exit record from.
        for (const session of this.registry.list()) {
          // A session that has already exited but is still in the registry
          // (not yet `forget`-ten) is not "live" -- the disk record from
          // above, if any, is authoritative for it.
          if (session.status === 'stopped' || session.status === 'failed') continue;
          const snapshot = session.snapshot();
          if (root && snapshot.root !== root) continue;
          const runId = `${snapshot.startedAt}-${safe(snapshot.id)}`;
          const onDisk = live.get(runId);
          live.set(runId, {
            runId,
            sessionId: snapshot.id,
            name: snapshot.name,
            kind: snapshot.kind,
            root: snapshot.root ?? null,
            startedAt: snapshot.startedAt,
            endedAt: onDisk?.endedAt,
            exitCode: snapshot.exitCode ?? onDisk?.exitCode,
            sizeBytes: onDisk?.sizeBytes ?? 0,
            live: true,
          });
        }
        const merged = [...live.values()].sort((a, b) => b.startedAt - a.startedAt);
        return merged.slice(0, limit) satisfies RpcMethods['logHistory']['result'];
      }

      case 'logRead': {
        const params = p as RpcMethods['logRead']['params'];
        return this.history.read(params.run, { tail: params.tail, filter: params.filter }) satisfies RpcMethods['logRead']['result'];
      }

      case 'serviceExtension': {
        const params = p as RpcMethods['serviceExtension']['params'];
        const session = this.#require(params.session);
        if (!session.capabilities.has('serviceExtension' as Capability)) {
          throw new Error(`${session.kind} sessions have no service extensions`);
        }
        return (session as any).callServiceExtension(params.method, params.params ?? {}) satisfies Promise<RpcMethods['serviceExtension']['result']>;
      }

      case 'network': {
        const params = p as RpcMethods['network']['params'];
        const session = this.#requireCapture(params.session);
        return this.network.store.list(session.id, {
          since: params.since, filter: params.filter, tail: params.tail,
        }) satisfies RpcMethods['network']['result'];
      }

      case 'networkDetail': {
        const params = p as RpcMethods['networkDetail']['params'];
        // Deliberately not gated on the capability: a session that has stopped
        // capturing gets the specific "no longer capturing" message from the
        // service, which is more useful than the generic refusal.
        const session = this.#require(params.session);
        return this.network.detail(session.id, params.id, params.maxBody) satisfies Promise<RpcMethods['networkDetail']['result']>;
      }

      case 'networkClear': {
        const params = p as RpcMethods['networkClear']['params'];
        const session = this.#requireCapture(params.session);
        await this.network.clear(session.id);
        return { cleared: true } satisfies RpcMethods['networkClear']['result'];
      }

      case 'forget': {
        const params = p as RpcMethods['forget']['params'];
        // Resolve before forgetting: `params.session` may be a prefix, and the
        // network store is keyed by the full id.
        const session = this.registry.get(params.session);
        const forgotten = this.registry.forget(params.session);
        if (forgotten && session) this.network.forget(session.id);
        return { forgotten } satisfies RpcMethods['forget']['result'];
      }

      case 'shutdown':
        setTimeout(() => this.close().then(() => process.exit(0)), 50);
        return { stopping: true } satisfies RpcMethods['shutdown']['result'];

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

  /** A project plus what it can run, tolerant of one that has gone missing. */
  #describeProject(root: string): ProjectInfo {
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    if (!existsSync(root)) {
      return { root, name, targets: [], error: 'directory no longer exists' };
    }
    try {
      const targets = detectTargets(root).map((target) => ({
        name: target.name,
        kind: target.kind,
        source: target.source,
        issues: target.config ? validate(target.config) : [],
      }));
      return { root, name, targets };
    } catch (err) {
      return { root, name, targets: [], error: (err as Error).message };
    }
  }

  /**
   * Which project's Flutter SDK to run device discovery under.
   *
   * Devices are a property of the machine, not of a project -- but discovering
   * them needs a Flutter SDK, and a Node-only project has none. On a machine
   * where Flutter is pinned per project with FVM and absent from PATH, asking
   * from the wrong directory finds nothing at all. So prefer any known Flutter
   * project over the one that happened to ask.
   */
  #deviceRoot(cwd?: string | null): string {
    const asked = this.#resolveRoot(cwd);
    if (existsSync(join(asked, 'pubspec.yaml'))) return asked;
    const flutterProject = this.projects
      .list()
      .find((root) => existsSync(join(root, 'pubspec.yaml')));
    return flutterProject ?? asked;
  }

  /**
   * A session that is actually capturing HTTP traffic.
   *
   * The capability, not the store, is what is checked: a capturing session that
   * has simply seen no traffic yet must answer with an empty list, while a
   * session that cannot capture at all has to say so -- an empty list would be
   * read as "this app made no requests", and the reader would go looking for the
   * wrong bug.
   */
  #requireCapture(id: string): Session {
    const session = this.#require(id);
    if (!session.capabilities.has('network' as Capability)) {
      throw new Error(
        `${session.id} has no network capture — it needs a Flutter app running in debug or ` +
          'profile mode (capture attaches by itself once the VM service is up)',
      );
    }
    return session;
  }

  #require(id: string) {
    const session = this.registry.get(id);
    if (session) return session;
    const ambiguous = this.registry.candidates(id);
    if (ambiguous.length > 1) {
      throw new Error(
        `"${id}" matches ${ambiguous.length} sessions — say which:\n` +
          ambiguous.map((s) => `  ${s.id}`).join('\n'),
      );
    }
    throw new Error(`no session matching "${id}"`);
  }

  /**
   * Which sessions a bulk operation applies to.
   *
   * `{ids: [...]}` exists for the multi-project HUD: "reload all" while looking
   * at one project must not touch the other projects' sessions.
   */
  #select(p: Record<string, any>) {
    if (Array.isArray(p.ids)) {
      return p.ids
        .map((id: string) => this.registry.get(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));
    }
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

/**
 * Match a target by exact name, then case-insensitive substring.
 *
 * Mirrors `SessionRegistry.get()`: an unambiguous partial name is a convenience,
 * but a substring that fits several targets must not silently pick one -- that
 * would run the wrong thing. Use `matchCandidates` to list them instead.
 */
export function matchTarget<T extends { name: string }>(targets: T[], query: string): T | undefined {
  if (!query) return undefined;
  const exact = targets.find((t) => t.name === query);
  if (exact) return exact;
  const matches = matchCandidates(targets, query);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Every target whose name contains `query`, case-insensitively -- what `matchTarget` considered. */
export function matchCandidates<T extends { name: string }>(targets: T[], query: string): T[] {
  const lower = query.toLowerCase();
  return targets.filter((t) => t.name.toLowerCase().includes(lower));
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
