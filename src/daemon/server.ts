import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { SessionRegistry } from '../core/registry.ts';
import { detectTargets, findProjectRoot, isProjectRoot } from '../config/detect.ts';
import { validate, type ValidationIssue } from '../config/validate.ts';
import { loadConfigs, type LaunchConfig } from '../config/loader.ts';
import {
  applyLaunchEdits, configEntries, configsFromText, generateLaunchJson, launchFileFor,
  parseLaunchText, writeLaunchFile,
} from '../config/writer.ts';
import { browseDirs } from './browse.ts';
import { ProjectRegistry } from '../core/projects.ts';
import { handshakePath, sessionLogDir } from '../core/paths.ts';
import { renderHud, HUD_ASSETS } from '../hud/render.ts';
import { LogHistory, safe } from '../core/log-store.ts';
import { LogSink } from './log-sink.ts';
import { NetworkStore } from '../core/network-store.ts';
import { NetworkService, type CreateVmClient } from './network.ts';
import { screenshotSession } from './capture.ts';
import { waitForSession, type WaitableSession } from './waiter.ts';
import {
  getProof, listProofs, runProof, type ProofHost, type ProofRunParams,
} from './proof.ts';
import type { Capability, Session, SessionSnapshot } from '../core/types.ts';
import type {
  LaunchWriteResult, ProjectInfo, PushEvent, RpcMethods, TargetInfo,
} from '../core/api.ts';

export type LaunchDaemonOptions = {
  /** Injectable for tests; defaults to a real store rooted at `stateDir()`. */
  history?: LogHistory;
  /** How network capture opens a VM service connection; injected in tests. */
  createClient?: CreateVmClient;
  /** How often capture polls the app's HTTP profile. Tests use a few milliseconds. */
  networkPollIntervalMs?: number;
  /** How long capture waits before retrying a failed attach. Tests shorten it. */
  networkRetryBaseMs?: number;
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
  /** The most recent reload/restart outcome per session, for `summary`. */
  #lastOperation = new Map<string, { kind: 'reload' | 'restart'; ok: boolean; at: number; message?: string }>();
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
      { pollIntervalMs: options.networkPollIntervalMs, retryBaseMs: options.networkRetryBaseMs },
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
        // A real project with nothing runnable is not a failure and not an empty
        // tab -- it is a project that has not been configured yet. Say so, and
        // let the caller offer to write a launch.json. It is deliberately not
        // remembered until it has something to offer: a HUD full of blank tabs
        // for directories you glanced at once is worse than no memory at all.
        if (!described.error && described.targets.length === 0) {
          return { ...described, needsConfig: true } satisfies RpcMethods['addProject']['result'];
        }
        this.projects.remember(root);
        return described satisfies RpcMethods['addProject']['result'];
      }

      case 'removeProject': {
        const params = p as RpcMethods['removeProject']['params'];
        return { removed: this.projects.forget(String(params.root ?? '')) } satisfies RpcMethods['removeProject']['result'];
      }

      case 'browseDirs': {
        const params = p as RpcMethods['browseDirs']['params'];
        return browseDirs(params.path ?? undefined) satisfies RpcMethods['browseDirs']['result'];
      }

      case 'readLaunchConfig': {
        const params = p as RpcMethods['readLaunchConfig']['params'];
        const root = this.#resolveRoot(params.root);
        const file = launchFileFor(root);
        if (!file) {
          return {
            file: null, text: null, configs: [], configIndexes: [], configCount: 0,
            issues: {}, parseErrors: [],
          } satisfies RpcMethods['readLaunchConfig']['result'];
        }

        const text = readFileSync(file, 'utf8');
        const mtimeMs = statSync(file).mtimeMs;
        const { doc, errors } = parseLaunchText(text);
        // A file we cannot understand is exactly the file the editor exists to
        // repair, so the raw text always comes back -- refusing the call would
        // leave the user with no way to see, let alone fix, the problem.
        const parseErrors = [...errors];
        let entries: Array<{ index: number; config: LaunchConfig }> = [];
        let configCount = 0;
        if (parseErrors.length === 0) {
          const configurations = (doc as { configurations?: unknown } | undefined)?.configurations;
          if (Array.isArray(configurations)) configCount = configurations.length;
          if (!Array.isArray(configurations)) {
            // Valid JSON that is not a launch.json. Said in the same words
            // `loader.ts` uses, so the two never read as different problems.
            parseErrors.push({ line: 1, col: 1, message: `${file}: no "configurations" array` });
          } else {
            entries = configEntries(text, root);
          }
        }
        const configs = entries.map((entry) => entry.config);
        return {
          file, text, mtimeMs, configs, configCount,
          configIndexes: entries.map((entry) => entry.index),
          issues: issuesFor(configs), parseErrors,
        } satisfies RpcMethods['readLaunchConfig']['result'];
      }

      case 'generateLaunchConfig': {
        const params = p as RpcMethods['generateLaunchConfig']['params'];
        const root = this.#resolveRoot(params.root);
        const targets: TargetInfo[] = detectTargets(root).map((target) => ({
          ...target,
          issues: target.config ? validate(target.config) : [],
        }));
        return {
          text: generateLaunchJson(root), targets,
        } satisfies RpcMethods['generateLaunchConfig']['result'];
      }

      case 'writeLaunchConfig': {
        const params = p as RpcMethods['writeLaunchConfig']['params'];
        const root = this.#resolveRoot(params.root);
        // An explicit choice wins. Otherwise write back to the file the project
        // already uses: defaulting to .vscode when the project keeps its config
        // in .claude would create a second file that silently takes precedence
        // over the one being edited.
        const file = params.file
          ? join(root, params.file === 'claude' ? '.claude' : '.vscode', 'launch.json')
          : launchFileFor(root) ?? join(root, '.vscode', 'launch.json');

        const { mtimeMs } = writeLaunchFile(file, String(params.text ?? ''), params.expectedMtimeMs);
        // Configuring a project is the clearest possible statement that you
        // intend to work in it.
        this.projects.remember(root);
        return this.#launchResult(file, root, mtimeMs);
      }

      case 'editLaunchConfig': {
        const params = p as RpcMethods['editLaunchConfig']['params'];
        const root = this.#resolveRoot(params.root);
        const file = launchFileFor(root);
        if (!file) {
          throw new Error(`no launch.json in ${root} — generate one first (baton init, or Create in the HUD)`);
        }
        // Straight off the wire, so the shape is checked rather than assumed:
        // a malformed `edits` would otherwise throw a TypeError from inside
        // jsonc-parser, which says nothing useful to whoever sent it.
        const list = Array.isArray(params.edits) ? params.edits : [];
        if (list.some((edit) => !edit || !Array.isArray(edit.path))) {
          throw new Error('each edit needs a `path` array, e.g. ["configurations", 0, "program"]');
        }
        // A path element is a key or an index, nothing else. jsonc-parser walks
        // whatever it is handed and fails somewhere inside itself, which tells
        // the caller nothing about what it got wrong.
        if (list.some((edit) => edit.path.some((part) => typeof part !== 'string' && typeof part !== 'number'))) {
          throw new Error('path elements must be a string key or a number index');
        }
        const edited = applyLaunchEdits(readFileSync(file, 'utf8'), list);
        const { mtimeMs } = writeLaunchFile(file, edited, params.expectedMtimeMs);
        this.projects.remember(root);
        return this.#launchResult(file, root, mtimeMs);
      }

      case 'validateLaunchConfig': {
        const params = p as RpcMethods['validateLaunchConfig']['params'];
        const root = this.#resolveRoot(params.root);
        const text = String(params.text ?? '');
        const { errors } = parseLaunchText(text);
        // Nothing can be said about the configurations in text that does not
        // parse, and guessing at them would put noise under a real error.
        if (errors.length > 0) {
          return { parseErrors: errors, issues: {} } satisfies RpcMethods['validateLaunchConfig']['result'];
        }
        return {
          parseErrors: [], issues: issuesFor(configsFromText(text, root)),
        } satisfies RpcMethods['validateLaunchConfig']['result'];
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
        const kind = full ? 'restart' as const : 'reload' as const;
        const results = await Promise.all(
          sessions.map(async (s) => {
            try {
              const result = full
                ? await s.hotRestart(params.reason)
                : await s.hotReload(params.reason);
              // Recorded for `summary` -- the simplest accurate way to answer
              // "what did the last reload do?" without touching every adapter.
              this.#lastOperation.set(s.id, { kind, ok: result.code === 0, at: Date.now(), message: result.message });
              // A failed reload reports only a summary ("DevFS synchronization
              // failed"). The actionable part -- file, line, message -- is in the
              // log stream, so attach it: an agent that broke the build needs the
              // error itself, not a category.
              if (result.code !== 0) {
                return { session: s.id, ...result, errors: recentErrors(s) };
              }
              return { session: s.id, ...result };
            } catch (err) {
              const message = (err as Error).message;
              this.#lastOperation.set(s.id, { kind, ok: false, at: Date.now(), message });
              return { session: s.id, code: 1, message };
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
        // A session that captured and has since stopped keeps the capability, so
        // it passes this gate and gets the more specific "no longer capturing"
        // from the service. Only a session that never captured is refused here.
        const session = this.#requireCapture(params.session);
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
        if (forgotten && session) {
          this.network.forget(session.id);
          this.#lastOperation.delete(session.id);
        }
        return { forgotten } satisfies RpcMethods['forget']['result'];
      }

      case 'screenshot': {
        const params = p as RpcMethods['screenshot']['params'];
        const session = this.#require(params.session);
        if (!session.capabilities.has('screenshot' as Capability)) {
          throw new Error(`${session.kind} sessions have no screenshot capability`);
        }
        const snapshot = session.snapshot();
        return screenshotSession(
          snapshot, params.out, undefined, this.#devicePlatform(snapshot),
        ) satisfies Promise<RpcMethods['screenshot']['result']>;
      }

      case 'wait': {
        const params = p as RpcMethods['wait']['params'];
        // Every real `Session` is a `BaseSession`, i.e. an `EventEmitter` --
        // `removeListener` exists at runtime even though the `Session`
        // interface itself does not promise it.
        const session = this.#require(params.session) as unknown as WaitableSession;
        return waitForSession(
          session, params.until, params.timeoutMs, recentErrors,
        ) satisfies Promise<RpcMethods['wait']['result']>;
      }

      case 'summary': {
        const params = p as RpcMethods['summary']['params'];
        const session = this.#require(params.session);
        const snapshot = session.snapshot();
        const network = session.capabilities.has('network' as Capability)
          ? this.network.store.counts(session.id)
          : undefined;
        return {
          session: snapshot,
          uptimeMs: Date.now() - snapshot.startedAt,
          recentErrors: recentErrors(session),
          logLines: session.recentLogs().length,
          network,
          lastOperation: this.#lastOperation.get(session.id),
        } satisfies RpcMethods['summary']['result'];
      }

      case 'proofRun': {
        const params = p as RpcMethods['proofRun']['params'];
        const host = this.#proofHost();
        const result = await runProof(host, params as ProofRunParams);
        return result satisfies RpcMethods['proofRun']['result'];
      }

      case 'proofList': {
        const params = p as RpcMethods['proofList']['params'];
        return listProofs(params.limit ?? 50) satisfies RpcMethods['proofList']['result'];
      }

      case 'proofGet': {
        const params = p as RpcMethods['proofGet']['params'];
        const proof = getProof(params.id);
        if (!proof) throw new Error(`no proof matching "${params.id}"`);
        return proof satisfies RpcMethods['proofGet']['result'];
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

  /**
   * What a launch.json save produced, read back from the file that was written.
   *
   * Read back rather than derived from the text we just sent: what the project
   * actually runs from here on is what is on disk, and a caller that trusts its
   * own draft over the file is one rename away from being wrong.
   */
  #launchResult(file: string, root: string, mtimeMs: number): LaunchWriteResult {
    let configs: LaunchConfig[] = [];
    try {
      configs = loadConfigs(file, root);
    } catch {
      // Unreachable through a write we performed: `writeLaunchFile` refuses
      // anything `loadConfigs` would reject. It stays as a guard against the
      // narrow race where someone replaced the file between the rename and this
      // read -- their file, not ours to report on, and the write did happen.
    }
    return { file, mtimeMs, configs, issues: issuesFor(configs) };
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

  /**
   * The authoritative platform for a session's device target, when known.
   *
   * `capture.ts` falls back to guessing from the id's shape, but the device
   * registry -- when the project's Flutter daemon has already reported this
   * device -- knows for certain. Never blocks: only devices already discovered
   * are considered, so a screenshot never waits on a fresh device scan.
   */
  #devicePlatform(snapshot: SessionSnapshot): string | undefined {
    if (!snapshot.root || !snapshot.target) return undefined;
    return this.registry.devices(snapshot.root).list().find((d) => d.id === snapshot.target)?.platformType;
  }

  /** Injectable seam for `runProof` — wires the daemon's real session machinery. */
  #proofHost(): ProofHost {
    const root = this.#resolveRoot();
    return {
      root,
      matchTarget: (query) => {
        const targets = detectTargets(root);
        return matchTarget(targets, query);
      },
      matchTargetCandidates: (query) => matchCandidates(detectTargets(root), query),
      listDevices: async () => {
        const devices = this.registry.devices(this.#deviceRoot());
        await devices.ready(500);
        return { connected: devices.list(), bootables: await devices.bootables() };
      },
      boot: (id) => this.registry.devices(this.#deviceRoot()).boot(id),
      run: (target, deviceId) => this.registry.run(target, { deviceId }),
      waitRunning: async (session, timeoutMs) => {
        try {
          await waitForSession(
            session as unknown as WaitableSession,
            'running',
            timeoutMs,
            recentErrors,
          );
          return true;
        } catch {
          return false;
        }
      },
      waitStopped: async (session, timeoutMs) => {
        if (session.status === 'stopped' || session.status === 'failed') return;
        await waitForSession(
          session as unknown as WaitableSession,
          'stopped',
          timeoutMs,
          recentErrors,
        );
      },
      screenshot: async (session, path) => {
        const snapshot = session.snapshot();
        await screenshotSession(
          snapshot, path, undefined, this.#devicePlatform(snapshot),
        );
      },
      logs: (session) => session.recentLogs(),
      network: (session) => {
        if (!session.capabilities.has('network' as Capability)) return [];
        return this.network.store.list(session.id);
      },
      stop: (session) => session.stop(),
      forget: (session) => {
        this.registry.forget(session.id);
        this.network.forget(session.id);
        this.#lastOperation.delete(session.id);
      },
      onProgress: (event) => this.#broadcast({ event: 'proof', ...event } satisfies PushEvent),
    };
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
 * Pre-flight issues keyed by configuration name.
 *
 * Keyed by name rather than index so the HUD's form can attach a warning to the
 * card the user is looking at, and survive a reordered file.
 */
function issuesFor(configs: LaunchConfig[]): Record<string, ValidationIssue[]> {
  const issues: Record<string, ValidationIssue[]> = {};
  for (const config of configs) issues[config.name] = validate(config);
  return issues;
}

/**
 * Pull the compiler diagnostics out of a session's recent output.
 *
 * Matches the shapes the major toolchains print: `path:line:col: Error: ...`
 * (Dart, TypeScript, Rust) and bare `Error:` / `error TS1234:` lines.
 */
export function recentErrors(session: { recentLogs: (n?: number) => { text: string; error: boolean }[] }): string[] {
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
