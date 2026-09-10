import { EventEmitter } from 'node:events';
import type { Session, SessionCheckout, SessionSnapshot } from './types.ts';
import type { Target } from '../config/detect.ts';
import { FlutterSession } from '../adapters/flutter.ts';
import { WebDevSession } from '../adapters/web-dev.ts';
import { ReactNativeSession } from '../adapters/react-native.ts';
import { ProcessSession } from '../adapters/process.ts';
import { NativeBuildSession } from '../adapters/native-build.ts';
import { DeviceRegistry } from '../daemon/devices.ts';
import { resolveFlutter } from '../config/flutter.ts';
import { slug } from './session-base.ts';
import { toDartDefines } from '../workspace/exports.ts';
import type { LaunchConfig } from '../config/loader.ts';

/**
 * A Flutter config that carries `env` as compile-time defines.
 *
 * A Flutter app is a compiled binary on a device or simulator; the env of the
 * `flutter run` process on the developer's laptop never reaches it. Handing a
 * workspace's `API_URL` to a Flutter node therefore means `--dart-define`,
 * which `buildFlutterArgv` already appends via `toolArgs`. The env is merged
 * too, since the tool process itself may legitimately want it.
 */
export function flutterConfigWith(
  config: LaunchConfig,
  env?: Record<string, string>,
): LaunchConfig {
  if (!env || Object.keys(env).length === 0) return config;
  return {
    ...config,
    env: { ...config.env, ...env },
    toolArgs: [...config.toolArgs, ...toDartDefines(env)],
  };
}

export type RunOptions = {
  deviceId?: string;
  /** Project the HUD groups this under. Defaults to `target.cwd`. */
  projectRoot?: string;
  /** When set and not inplace, the process runs from `checkout.cwd`. */
  checkout?: SessionCheckout;
  /** Workflow name when this run is one step of a multi-project plan. */
  workflow?: string;
  /**
   * Extra environment merged over the target's own `env`.
   *
   * This is how a workspace hands a node its dependencies' URLs. Flutter apps
   * cannot read env at all, so for them these become `--dart-define`s instead.
   */
  env?: Record<string, string>;
  /** The workspace node this run belongs to, when a workspace started it. */
  workspace?: { id: string; node: string };
  /**
   * What to do when a session with this id already exists.
   *
   * The default stays `refuse`, so a person who types `baton run` twice still
   * gets told. A workspace passes `reuse`, because `up` is idempotent: finding
   * the node already running is success, not a collision.
   */
  ifRunning?: 'refuse' | 'reuse';
};

/**
 * Owns every running session and turns targets into the right adapter.
 *
 * One registry serves all clients -- HUD, CLI and MCP -- so a session started
 * from a terminal is immediately visible in the HUD and to an agent.
 */
export class SessionRegistry extends EventEmitter {
  #sessions = new Map<string, Session>();
  #devicesByRoot = new Map<string, DeviceRegistry>();

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  snapshots(): SessionSnapshot[] {
    return this.list().map((s) => s.snapshot());
  }

  get(id: string): Session | undefined {
    // Accept an unambiguous prefix, so nobody has to type a full session id.
    const exact = this.#sessions.get(id);
    if (exact) return exact;
    const matches = this.candidates(id);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Everything a partial name could mean.
   *
   * Ids are project-scoped (`demo-web/npm-dev`), so a bare `npm-dev` typed in a
   * terminal has to match the part after the slash too -- and when two projects
   * both have one, the caller needs the list to disambiguate with.
   */
  candidates(query: string): Session[] {
    const lower = query.toLowerCase();
    return this.list().filter(
      (s) =>
        s.id.startsWith(query) ||
        (s.id.split('/').pop() ?? '').startsWith(query) ||
        s.name.toLowerCase().includes(lower),
    );
  }

  devices(projectRoot: string): DeviceRegistry {
    let registry = this.#devicesByRoot.get(projectRoot);
    if (!registry) {
      registry = new DeviceRegistry(projectRoot);
      this.#devicesByRoot.set(projectRoot, registry);
    }
    return registry;
  }

  async run(target: Target, options: RunOptions = {}): Promise<Session> {
    const created = await this.#create(target, options);
    const session = this.own(created, { ...options, projectRoot: options.projectRoot ?? target.cwd });
    // `own` hands back the live session it found instead of the new one when the
    // caller asked to reuse; that one is already running, so leave it alone.
    if (session !== created) return session;
    session.start();
    this.emit('change', session.snapshot());
    return session;
  }

  /**
   * Take ownership of an already-built session: register it and wire its events.
   *
   * Split out of `run` because creating a session and owning one are different
   * jobs -- `run` has to pick a device and spawn a process, while a session that
   * already exists (a Compose container, a replay, a future attach-to-a-running
   * -app) needs only this half. Does not `start()` it: the caller decides when.
   */
  own(session: Session, options: RunOptions = {}): Session {
    // Which project this came from -- the HUD groups by it, so three projects
    // can be watched side by side without their sessions blurring together.
    if (options.projectRoot !== undefined) (session as { root?: string }).root = options.projectRoot;

    const existing = this.#sessions.get(session.id);
    if (existing) {
      const terminal = existing.status === 'stopped' || existing.status === 'failed';
      if (terminal) {
        // A finished session is history, not an obstacle. Evicting it here is
        // what lets a workspace restart a node with new env without anyone
        // having to type `baton forget` first; listeners are told so the HUD
        // drops the old row rather than showing two.
        this.#sessions.delete(existing.id);
        this.emit('forgotten', existing.id);
      } else if (options.ifRunning === 'reuse') {
        return existing;
      } else {
        throw new Error(
          `a session for "${session.name}" is already running on this device (${session.id})`,
        );
      }
    }

    if (options.checkout && options.checkout.kind !== 'inplace') session.checkout = options.checkout;
    if (options.workflow) session.workflow = options.workflow;
    if (options.workspace) session.workspace = options.workspace;

    this.#sessions.set(session.id, session);
    session.on('change', () => this.emit('change', session.snapshot()));
    session.on('log', (text: string, error: boolean, at?: number) =>
      this.emit('log', session.id, text, error, at),
    );
    session.on('network', (row) => this.emit('network', session.id, row));
    session.on('exit', () => this.emit('change', session.snapshot()));
    return session;
  }

  /** Backwards-compatible shorthand for `own`, from before there were options. */
  adopt(session: Session, root?: string): Session {
    return this.own(session, root === undefined ? {} : { projectRoot: root });
  }

  /** Workspace env wins over the target's own: it describes where things actually are today. */
  static #env(target: Target, options: RunOptions): Record<string, string> | undefined {
    if (!options.env || Object.keys(options.env).length === 0) return target.config?.env;
    return { ...target.config?.env, ...options.env };
  }

  async #create(target: Target, options: RunOptions): Promise<Session> {
    const env = SessionRegistry.#env(target, options);
    const idRoot = options.projectRoot;
    const checkoutSlug = options.checkout && options.checkout.kind !== 'inplace'
      ? slug(options.checkout.ref ?? options.checkout.cwd.split(/[\\/]/).pop() ?? 'checkout')
      : undefined;
    const ids = { idRoot, checkoutSlug };

    switch (target.kind) {
      case 'flutter': {
        const config = flutterConfigWith(
          options.deviceId ? { ...target.config!, deviceId: options.deviceId } : target.config!,
          options.env,
        );
        const devices = this.devices(idRoot ?? target.cwd);
        const device = await devices.waitForDevice(
          config.name,
          options.deviceId ?? config.deviceId,
        );
        if (!device) {
          const wanted = DeviceRegistry.describePreference(config.name);
          const available = devices.list();
          throw new Error(
            `"${config.name}" needs ${wanted}, and none is connected.\n` +
              (available.length
                ? `Available: ${available.map((d) => `${d.name} (${d.platformType})`).join(', ')}\n` +
                  `Force one with --device <id> if that is what you meant.`
                : 'No devices were detected at all. Boot a simulator or connect a device, then retry.'),
          );
        }
        return new FlutterSession(config, {
          deviceId: device.id,
          flutter: resolveFlutter(target.cwd),
          ...ids,
        });
      }

      case 'web-dev':
        return WebDevSession.create(target.name, {
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env, trace: target.config?.batonTrace, ...ids,
        });

      case 'react-native':
        return ReactNativeSession.create(target.name, {
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env, trace: target.config?.batonTrace, ...ids,
        });

      case 'ios':
      case 'android': {
        const devices = this.devices(idRoot ?? target.cwd);
        const device = await devices.waitForDevice(target.name, options.deviceId);
        if (!device) {
          const wanted = DeviceRegistry.describePreference(target.name);
          const available = devices.list();
          throw new Error(
            `"${target.name}" needs ${wanted} so the app can actually launch, and none is connected.\n` +
              (available.length
                ? `Available: ${available.map((d) => `${d.name} (${d.platformType})`).join(', ')}`
                : 'No devices were detected. Boot a simulator or connect a device, then retry.'),
          );
        }
        if (device.platformType !== target.kind) {
          throw new Error(
            `"${target.name}" is ${target.kind} but ${device.name} is ${device.platformType}. Pick a matching device.`,
          );
        }
        return NativeBuildSession.create(target.kind, target.name, {
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env,
          deviceId: device.id, ...ids,
        });
      }

      case 'process':
        return ProcessSession.forCommand(target.name, {
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env, trace: target.config?.batonTrace, ...ids,
        });
      default: {
        const _exhaustive: never = target.kind;
        throw new Error(`unknown target kind: ${_exhaustive}`);
      }
    }
  }

  /** Remove a stopped session from the list; running ones must be stopped first. */
  forget(id: string): boolean {
    const session = this.get(id);
    if (!session) return false;
    if (session.status === 'running' || session.status === 'starting') return false;
    return this.#sessions.delete(session.id);
  }

  /** Drop every stopped or failed session from the registry. */
  forgetStopped(): string[] {
    const removed: string[] = [];
    for (const session of this.list()) {
      if (session.status === 'running' || session.status === 'starting') continue;
      if (this.#sessions.delete(session.id)) removed.push(session.id);
    }
    return removed;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.list().map((s) => s.stop()));
    for (const registry of this.#devicesByRoot.values()) registry.dispose();
    this.#devicesByRoot.clear();
  }
}
