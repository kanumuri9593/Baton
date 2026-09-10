import { EventEmitter } from 'node:events';
import { slug } from '../core/session-base.ts';
import type { WaitUntil } from '../daemon/waiter.ts';
import { chosenProvider, type LoadedManifest, type WorkspaceManifest, type WorkspaceProvider } from './manifest.ts';
import { dependentsOf, reverseTopo, topoLevels, validateGraph } from './graph.ts';
import { dependencyEnv } from './exports.ts';
import { NodeHealth, repeatableProbe } from './health.ts';
import { WorkspaceChoices } from './choices.ts';
import type { WorkspaceHost } from './host.ts';
import type { NodeState, WorkspaceDownResult, WorkspaceRun, WorkspaceUpOptions } from './types.ts';

const HEALTH_INTERVAL_MS = 15_000;

/** Everything the engine keeps about a workspace beyond what clients see. */
type LiveRun = {
  run: WorkspaceRun;
  manifest: WorkspaceManifest;
  health: NodeHealth;
};

export type WorkspaceEngineOptions = {
  host: WorkspaceHost;
  choices?: WorkspaceChoices;
  healthIntervalMs?: number;
};

/**
 * Brings a declared system up, keeps track of what it owns, and puts it down.
 *
 * The rules that matter, and why:
 *
 * - **Validate the whole graph first.** Bring-up is parallel and only partly
 *   reversible; discovering a cycle halfway up leaves a half-started system.
 * - **Only start what is not already up.** `up` is idempotent, so running it
 *   after stopping one node restarts exactly that node.
 * - **Attribute failures.** A node whose dependency failed is `skipped` and
 *   says which node, and why — never a bare "not started".
 * - **Stop only what Baton started.** Remote endpoints and containers that were
 *   already running are `external`: reported, used, never touched.
 */
export class WorkspaceEngine extends EventEmitter {
  #runs = new Map<string, LiveRun>();
  #host: WorkspaceHost;
  #choices: WorkspaceChoices;
  #healthIntervalMs: number;

  constructor(options: WorkspaceEngineOptions) {
    super();
    this.#host = options.host;
    this.#choices = options.choices ?? new WorkspaceChoices();
    this.#healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  }

  list(): WorkspaceRun[] {
    return [...this.#runs.values()].map((live) => live.run);
  }

  /** A run by workspace id or by manifest path — clients have one or the other. */
  get(idOrPath: string): WorkspaceRun | undefined {
    const byPath = this.#runs.get(idOrPath);
    if (byPath) return byPath.run;
    return this.list().find((run) => run.id === idOrPath);
  }

  /**
   * Bring a workspace up, in dependency order, in parallel where it is safe.
   *
   * Returns once every node it was asked to start has settled, so a caller
   * never has to poll to find out whether the system came up.
   */
  async up(loaded: LoadedManifest, options: WorkspaceUpOptions = {}): Promise<WorkspaceRun> {
    const { manifest, manifestPath } = loaded;
    validateGraph(manifest);

    const persisted = this.#choices.get(manifestPath);
    // Resolving every provider before anything starts means an ambiguous or
    // misspelled node is refused with nothing left running behind it.
    const providers = new Map<string, string>();
    for (const node of Object.keys(manifest.nodes)) {
      providers.set(node, chosenProvider(manifest, node, options.providers ?? {}, persisted));
    }

    const live = this.#ensureRun(loaded, providers);
    const wanted = this.#wanted(manifest, options.nodes);

    for (const level of topoLevels(manifest)) {
      const batch = level.filter((node) => wanted.has(node));
      await Promise.all(batch.map((node) => this.#bring(live, node)));
    }

    return live.run;
  }

  /** The nodes to act on: those asked for, plus everything they depend on. */
  #wanted(manifest: WorkspaceManifest, only?: string[]): Set<string> {
    if (!only || only.length === 0) return new Set(Object.keys(manifest.nodes));
    const wanted = new Set<string>();
    const queue = [...only];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (wanted.has(node)) continue;
      if (!manifest.nodes[node]) throw new Error(`"${node}" is not a node in this workspace`);
      wanted.add(node);
      queue.push(...manifest.nodes[node].dependsOn);
    }
    return wanted;
  }

  #ensureRun(loaded: LoadedManifest, providers: Map<string, string>): LiveRun {
    const { manifest, manifestPath, root } = loaded;
    const existing = this.#runs.get(manifestPath);

    if (existing) {
      // Re-reading the manifest is deliberate: a node added since the last `up`
      // should appear, and a provider override should apply to this run.
      existing.manifest = manifest;
      existing.run.name = manifest.name;
      for (const [node, declared] of Object.entries(manifest.nodes)) {
        const state = existing.run.nodes[node];
        if (!state) {
          existing.run.nodes[node] = this.#pending(node, declared.kind, providers.get(node)!, declared.dependsOn);
          continue;
        }
        state.kind = declared.kind;
        state.dependsOn = declared.dependsOn;
        if (state.provider !== providers.get(node)) {
          state.provider = providers.get(node)!;
          // A different provider means whatever is up is the wrong thing.
          if (state.status === 'ready' || state.status === 'external') state.status = 'pending';
        }
      }
      for (const node of Object.keys(existing.run.nodes)) {
        if (!manifest.nodes[node]) delete existing.run.nodes[node];
      }
      return existing;
    }

    const run: WorkspaceRun = {
      id: this.#freeId(manifest.name),
      name: manifest.name,
      manifestPath,
      root,
      startedAt: Date.now(),
      nodes: Object.fromEntries(
        Object.entries(manifest.nodes).map(([node, declared]) =>
          [node, this.#pending(node, declared.kind, providers.get(node)!, declared.dependsOn)]),
      ),
    };
    const live: LiveRun = {
      run,
      manifest,
      health: new NodeHealth(
        (probe, timeoutMs) => this.#host.probe(probe, timeoutMs),
        (node, healthy, detail) => this.#onHealth(manifestPath, node, healthy, detail),
        this.#healthIntervalMs,
      ),
    };
    this.#runs.set(manifestPath, live);
    return live;
  }

  #pending(name: string, kind: NodeState['kind'], provider: string, dependsOn: string[]): NodeState {
    return { name, kind, provider, dependsOn: [...dependsOn], status: 'pending', readOnly: false };
  }

  /** Ids are for humans to type, so they are the workspace name, not a uuid. */
  #freeId(name: string): string {
    const base = slug(name) || 'workspace';
    const taken = new Set(this.list().map((run) => run.id));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
  }

  /** Start one node, unless a dependency already made that pointless. */
  async #bring(live: LiveRun, node: string): Promise<void> {
    const state = live.run.nodes[node];
    if (state.status === 'ready' || state.status === 'external' || state.status === 'unhealthy') return;

    const blocker = state.dependsOn
      .map((dep) => live.run.nodes[dep])
      .find((dep) => dep && (dep.status === 'failed' || dep.status === 'skipped'));
    if (blocker) {
      this.#set(live, node, {
        status: 'skipped',
        error: blocker.status === 'failed'
          ? `${blocker.name} failed (${blocker.error ?? 'no reason reported'})`
          : `${blocker.name} was skipped (${blocker.error ?? 'no reason reported'})`,
      });
      return;
    }

    const startedAt = Date.now();
    this.#set(live, node, { status: 'starting', error: undefined, elapsedMs: undefined });
    try {
      await this.#start(live, node);
      this.#set(live, node, { elapsedMs: Date.now() - startedAt });
    } catch (error) {
      this.#set(live, node, {
        status: 'failed',
        error: String((error as Error).message).slice(0, 2000),
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  async #start(live: LiveRun, node: string): Promise<void> {
    const declared = live.manifest.nodes[node];
    const state = live.run.nodes[node];
    const provider = declared.providers[state.provider];
    if (!provider) throw new Error(`${node} has no provider named "${state.provider}"`);

    if (provider.remote) return this.#startRemote(live, node, provider);

    const env = dependencyEnv(live.manifest, node, this.#urls(live));
    const workspace = { id: live.run.id, node };

    if (provider.compose) {
      const started = await this.#host.runCompose({
        file: provider.compose.file,
        service: provider.compose.service,
        root: live.run.root,
        workspace,
        workflow: live.run.name,
        timeoutMs: provider.timeoutMs,
      });
      await this.#settle(live, node, provider, started.session.id, provider.url ?? started.session.url, started.external);
      return;
    }

    const target = provider.target!;
    const session = await this.#host.runTarget({
      cwd: target.cwd,
      name: target.name,
      branch: target.branch,
      checkout: target.checkout,
      device: target.device,
      env,
      workspace,
      workflow: live.run.name,
    });
    // A session already claimed by another workspace is shared, not ours: it
    // stays usable, but this workspace's `down` must not stop it.
    const shared = Boolean(session.workspace && session.workspace.id !== live.run.id);
    await this.#settle(live, node, provider, session.id, provider.url ?? session.url, shared);
  }

  async #startRemote(live: LiveRun, node: string, provider: WorkspaceProvider): Promise<void> {
    const url = provider.url ?? provider.remote!.url;
    const probe = repeatableProbe(provider.ready, url);
    if (probe) await this.#host.probe(probe, provider.timeoutMs);
    this.#set(live, node, { status: 'external', url, readOnly: true, sessionId: undefined, error: undefined });
    this.#watch(live, node, provider);
  }

  /** Wait for readiness, then record what the node became. */
  async #settle(
    live: LiveRun,
    node: string,
    provider: WorkspaceProvider,
    sessionId: string,
    url: string | undefined,
    readOnly: boolean,
  ): Promise<void> {
    this.#set(live, node, { sessionId, url });
    const until = toWaitUntil(provider.ready);
    const ready = await this.#host.waitFor(sessionId, until, provider.timeoutMs);
    this.#set(live, node, {
      status: readOnly ? 'external' : 'ready',
      sessionId,
      url: url ?? ready.url,
      readOnly,
      error: undefined,
    });
    this.#watch(live, node, provider);
  }

  #watch(live: LiveRun, node: string, provider: WorkspaceProvider): void {
    const probe = repeatableProbe(provider.ready, live.run.nodes[node].url);
    if (probe) live.health.watch({ node, probe, timeoutMs: provider.timeoutMs });
  }

  #onHealth(manifestPath: string, node: string, healthy: boolean, detail?: string): void {
    const live = this.#runs.get(manifestPath);
    const state = live?.run.nodes[node];
    if (!live || !state) return;
    // Only a node that was up can go unhealthy: one that is still starting, or
    // that somebody stopped on purpose, is not a health problem.
    const wasUp = state.status === 'ready' || state.status === 'external' || state.status === 'unhealthy';
    if (!wasUp) return;

    if (healthy) {
      if (state.status !== 'unhealthy') return;
      this.#set(live, node, { status: state.readOnly ? 'external' : 'ready', error: undefined });
      return;
    }
    if (state.status === 'unhealthy') return;
    this.#set(live, node, { status: 'unhealthy', error: detail });
  }

  #urls(live: LiveRun): Record<string, string | undefined> {
    return Object.fromEntries(Object.entries(live.run.nodes).map(([node, state]) => [node, state.url]));
  }

  /** Put a workspace down in reverse dependency order, touching only what it owns. */
  async down(idOrPath: string): Promise<WorkspaceDownResult> {
    const live = this.#find(idOrPath);
    const stopped: string[] = [];
    const left: string[] = [];

    for (const node of reverseTopo(live.manifest)) {
      const state = live.run.nodes[node];
      if (!state) continue;
      live.health.forget(node);

      if (state.status === 'external' || state.readOnly) {
        if (state.status === 'external' || state.sessionId) left.push(node);
        continue;
      }
      if (!state.sessionId) {
        this.#set(live, node, { status: 'stopped' });
        continue;
      }
      await this.#host.stop(state.sessionId);
      this.#set(live, node, { status: 'stopped', sessionId: undefined, error: undefined });
      stopped.push(node);
    }

    live.health.dispose();
    return { id: live.run.id, name: live.run.name, stopped, left };
  }

  /**
   * Point a node somewhere else — local to Docker, Docker to a cloud endpoint.
   *
   * Dependents are restarted afterwards because their environment named the old
   * endpoint; leaving them running would leave them talking to something that
   * is no longer there.
   */
  async switch(idOrPath: string, node: string, provider: string): Promise<WorkspaceRun> {
    const live = this.#find(idOrPath);
    const declared = live.manifest.nodes[node];
    if (!declared) throw new Error(`"${node}" is not a node in this workspace`);
    if (!declared.providers[provider]) {
      throw new Error(`${node} offers ${Object.keys(declared.providers).join(', ')}, not "${provider}"`);
    }

    await this.#tearDown(live, node);
    live.run.nodes[node].provider = provider;
    this.#choices.set(live.run.manifestPath, node, provider);
    this.#set(live, node, { status: 'pending', url: undefined, readOnly: false, error: undefined });

    await this.#bring(live, node);
    await this.#restartDependents(live, node);
    return live.run;
  }

  /** Restart one node, and optionally everything downstream of it. */
  async restart(idOrPath: string, node: string, cascade = false): Promise<WorkspaceRun> {
    const live = this.#find(idOrPath);
    if (!live.manifest.nodes[node]) throw new Error(`"${node}" is not a node in this workspace`);

    const state = live.run.nodes[node];
    if (state.status === 'external' || state.readOnly) {
      throw new Error(`${node} is ${state.status === 'external' ? 'external' : 'shared'}; Baton did not start it`);
    }

    await this.#tearDown(live, node);
    this.#set(live, node, { status: 'pending', error: undefined });
    await this.#bring(live, node);
    if (cascade) await this.#restartDependents(live, node);
    return live.run;
  }

  /** Stop and start every dependent, in dependency order, skipping what we do not own. */
  async #restartDependents(live: LiveRun, node: string): Promise<void> {
    const affected = new Set(dependentsOf(live.manifest, node));
    if (affected.size === 0) return;

    for (const level of topoLevels(live.manifest)) {
      const batch = level.filter((name) => affected.has(name));
      await Promise.all(batch.map(async (name) => {
        const state = live.run.nodes[name];
        if (!state || state.status === 'external' || state.readOnly) return;
        await this.#tearDown(live, name);
        this.#set(live, name, { status: 'pending', error: undefined });
        await this.#bring(live, name);
      }));
    }
  }

  /**
   * Stop whatever a node is currently running.
   *
   * Always a full stop, never a hot restart: the whole point of restarting a
   * node here is that its environment changed, and a hot restart reuses the
   * environment the process was spawned with.
   */
  async #tearDown(live: LiveRun, node: string): Promise<void> {
    const state = live.run.nodes[node];
    live.health.forget(node);
    if (!state.sessionId || state.readOnly) return;
    await this.#host.stop(state.sessionId).catch(() => { /* already gone is fine */ });
    this.#set(live, node, { sessionId: undefined });
  }

  #find(idOrPath: string): LiveRun {
    const byPath = this.#runs.get(idOrPath);
    if (byPath) return byPath;
    const found = [...this.#runs.values()].find((live) => live.run.id === idOrPath);
    if (!found) throw new Error(`no workspace is up for "${idOrPath}"`);
    return found;
  }

  #set(live: LiveRun, node: string, patch: Partial<NodeState>): void {
    const state = live.run.nodes[node];
    if (!state) return;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (state as Record<string, unknown>)[key];
      else (state as Record<string, unknown>)[key] = value;
    }
    this.emit('change', live.run);
  }

  /**
   * Run one health round now, rather than waiting for the interval.
   *
   * The loops are on a timer precisely so nobody has to poll, but a caller that
   * wants a fresh answer this instant — a status command, a test — should not
   * have to wait fifteen seconds for one.
   */
  async checkHealth(): Promise<void> {
    await Promise.all([...this.#runs.values()].map((live) => live.health.tick()));
  }

  /** Stop the health loops. Sessions keep running; the daemon owns those. */
  dispose(): void {
    for (const live of this.#runs.values()) live.health.dispose();
  }
}

/** Manifest readiness, as the waiter's condition. */
export function toWaitUntil(ready: WorkspaceProvider['ready']): WaitUntil {
  return ready ?? 'running';
}
