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

export type RunOptions = {
  deviceId?: string;
  /** Project the HUD groups this under. Defaults to `target.cwd`. */
  projectRoot?: string;
  /** When set and not inplace, the process runs from `checkout.cwd`. */
  checkout?: SessionCheckout;
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
    const session = this.adopt(await this.#create(target, options), options.projectRoot ?? target.cwd);
    if (options.checkout && options.checkout.kind !== 'inplace') {
      session.checkout = options.checkout;
    }
    session.start();
    this.emit('change', session.snapshot());
    return session;
  }

  /**
   * Take ownership of an already-built session: register it and wire its events.
   *
   * Split out of `run` because creating a session and owning one are different
   * jobs -- `run` has to pick a device and spawn a process, while a session that
   * already exists (a replay, a future attach-to-a-running-app) needs only this
   * half. Does not `start()` it: the caller decides when, or whether, to.
   */
  adopt(session: Session, root?: string): Session {
    // Which project this came from -- the HUD groups by it, so three projects
    // can be watched side by side without their sessions blurring together.
    if (root !== undefined) (session as { root?: string }).root = root;

    if (this.#sessions.has(session.id)) {
      throw new Error(
        `a session for "${session.name}" is already running on this device (${session.id})`,
      );
    }

    this.#sessions.set(session.id, session);
    session.on('change', () => this.emit('change', session.snapshot()));
    session.on('log', (text: string, error: boolean, at?: number) =>
      this.emit('log', session.id, text, error, at),
    );
    session.on('network', (row) => this.emit('network', session.id, row));
    session.on('exit', () => this.emit('change', session.snapshot()));
    return session;
  }

  async #create(target: Target, options: RunOptions): Promise<Session> {
    const idRoot = options.projectRoot;
    const checkoutSlug = options.checkout && options.checkout.kind !== 'inplace'
      ? slug(options.checkout.ref ?? options.checkout.cwd.split(/[\\/]/).pop() ?? 'checkout')
      : undefined;
    const ids = { idRoot, checkoutSlug };

    switch (target.kind) {
      case 'flutter': {
        const config = options.deviceId
          ? { ...target.config!, deviceId: options.deviceId }
          : target.config!;
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
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env: target.config?.env, trace: target.config?.batonTrace, ...ids,
        });

      case 'react-native':
        return ReactNativeSession.create(target.name, {
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env: target.config?.env, trace: target.config?.batonTrace, ...ids,
        });

      case 'ios':
      case 'android':
        return NativeBuildSession.create(target.kind, target.name, {
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env: target.config?.env, ...ids,
        });

      case 'process':
        return ProcessSession.forCommand(target.name, {
          command: target.command!, args: target.args ?? [], cwd: target.cwd, env: target.config?.env, trace: target.config?.batonTrace, ...ids,
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
