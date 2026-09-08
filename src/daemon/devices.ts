import { spawn, type ChildProcess } from 'node:child_process';
import { MachineCodec, encodeRequest, type DaemonEvent, type DaemonResponse } from './protocol.ts';
import { resolveFlutter } from '../config/flutter.ts';
import {
  listSimulators, bootSimulator, mergeBootables,
  type Bootable, type FlutterEmulator,
} from './simulators.ts';

/** A platform constraint derived from a config name. */
export type DevicePreference = {
  platformType?: string;
  category?: string;
  emulator?: boolean;
  /** Extra name filter, e.g. prefer an iPad among iOS simulators. */
  match?: RegExp;
};

export type Device = {
  id: string;
  name: string;
  platform: string;
  platformType: string;
  emulator: boolean;
  category?: string;
  /** Which AVD/simulator definition this running device came from, when known. */
  emulatorId?: string;
  capabilities?: Record<string, boolean>;
};

/**
 * Discovers Flutter devices via a long-lived `flutter daemon`.
 *
 * Deliberately driven by the streaming `device.added` / `device.removed` events
 * rather than the `device.getDevices` request: that request awaits every device
 * discoverer in turn, so a single slow one (physical-device probing, in practice)
 * leaves it pending forever. Events arrive promptly and carry the same payload.
 */
export class DeviceRegistry {
  #devices = new Map<string, Device>();
  #child?: ChildProcess;
  #codec = new MachineCodec();
  #ready?: Promise<void>;
  #failure?: string;
  #projectRoot: string;
  #nextId = 100;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#codec.on('event', (e: DaemonEvent) => this.#handleEvent(e));
    this.#codec.on('response', (r: DaemonResponse) => this.#handleResponse(r));
  }

  /** Start the daemon and wait briefly for the first wave of devices. */
  async ready(settleMs = 4000): Promise<void> {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise<void>((resolve) => {
      const flutter = resolveFlutter(this.#projectRoot);
      const child = spawn(flutter.command, [...flutter.prefixArgs, 'daemon'], {
        cwd: this.#projectRoot,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
      });
      this.#child = child;
      child.stdout?.on('data', (c: Buffer) => this.#codec.push(c));
      // Once the child is gone, every request must fail immediately rather than
      // sit on a timeout: a missing Flutter SDK is a permanent condition, and
      // waiting 15s to discover that makes the device picker feel broken.
      const dead = (reason: string) => {
        this.#failure = reason;
        if (this.#child === child) this.#child = undefined;
        for (const pending of this.#pending.values()) pending.reject(new Error(reason));
        this.#pending.clear();
        resolve();
      };
      child.on('error', (err) => dead(`flutter daemon could not start: ${err.message}`));
      child.on('exit', () => dead('flutter daemon exited'));

      // Ask discovery to run with an explicit bound, so it cannot hang.
      child.stdin?.write(encodeRequest(1, 'device.enable', {}) + '\n');

      const timer = setTimeout(resolve, settleMs);
      timer.unref?.();
    });

    return this.#ready;
  }

  /** Feed raw daemon stdout. Public so tests and replays can drive discovery directly. */
  ingest(chunk: string | Buffer): void {
    this.#codec.push(chunk);
  }

  list(): Device[] {
    return [...this.#devices.values()];
  }

  /**
   * Everything that could be started but is not running.
   *
   * Merges two sources deliberately: simctl knows every individual iOS model,
   * while the Flutter daemon knows the Android AVDs and works on every platform.
   */
  async bootables(): Promise<Bootable[]> {
    let emulators: FlutterEmulator[] = [];
    try {
      emulators = (await this.#request<FlutterEmulator[]>('emulator.getEmulators', {}, 15000)) ?? [];
    } catch {
      // No Flutter SDK reachable, or no Android tooling: simulators still list.
    }

    return mergeBootables(listSimulators(), emulators, {
      deviceIds: new Set(this.list().map((d) => d.id)),
      emulatorIds: new Set(this.list().map((d) => d.emulatorId).filter(Boolean) as string[]),
    });
  }

  /**
   * Start a device and wait until Flutter can actually see it.
   *
   * Returning as soon as the boot command exits would be a lie: the device is
   * not runnable until discovery reports it, which is seconds later.
   */
  async boot(id: string, timeoutMs = 180000): Promise<Device> {
    await this.ready(500);
    const target = (await this.bootables()).find((b) => b.id === id);
    if (!target) throw new Error(`no bootable device with id "${id}"`);
    if (this.#failure) throw new Error(this.#failure + '. Check your Flutter SDK / PATH before booting a device.');

    if (target.via === 'simctl') {
      bootSimulator(target.id);
      const device = await this.#waitFor((d) => d.id === target.id, timeoutMs);
      if (device) return device;
    } else {
      await this.#request('emulator.launch', { emulatorId: target.id, coldBoot: false }, timeoutMs);
      const device = await this.#waitFor(
        (d) => d.emulatorId === target.id || (d.platformType === target.platformType && d.emulator),
        timeoutMs,
      );
      if (device) return device;
    }

    throw new Error(
      `"${target.name}" was asked to boot but never appeared as a Flutter device. ` +
        `It may still be starting -- check again in a moment.`,
    );
  }

  /**
   * What platform a config is asking for, read from its name.
   *
   * Real launch configs say what they target -- "iOS Simulator (DEV)",
   * "Android (TST)" -- which is the same signal a human uses when picking from
   * an IDE's device dropdown.
   */
  static platformFor(configName: string): DevicePreference | undefined {
    const name = configName.toLowerCase();
    if (/\bipad\b/.test(name)) return { platformType: 'ios', emulator: true, match: /ipad/i };
    if (/\bphysical\b/.test(name)) {
      const android = /\bandroid\b/.test(name);
      return { platformType: android ? 'android' : 'ios', emulator: false };
    }
    if (/\b(web|chrome)\b/.test(name)) return { platformType: 'web' };
    if (/\bandroid\b/.test(name)) return { platformType: 'android' };
    if (/\b(ios|iphone|simulator)\b/.test(name)) return { platformType: 'ios', emulator: true };
    if (/\b(macos|desktop|windows|linux)\b/.test(name)) return { category: 'desktop' };
    return undefined;
  }

  /**
   * Choose a device for a launch config.
   *
   * When the config names a platform, only that platform is considered. Falling
   * back across platforms would silently build an iOS config for macOS -- a
   * completely different, much slower build that looks like a hang. A clear
   * failure is strictly better, so this returns undefined instead.
   */
  resolveForName(configName: string, preferred?: string): Device | undefined {
    if (preferred) {
      const exact = this.#devices.get(preferred);
      if (exact) return exact;
    }

    const want = DeviceRegistry.platformFor(configName);
    const devices = this.list();
    if (!want) {
      // Flutter normally reports desktop and web before a booted phone. For a
      // platform-neutral target that made "Auto" silently choose macOS for a
      // mobile app. Prefer an already-running mobile emulator, then a physical
      // mobile device, with web and desktop as later fallbacks.
      return devices.toSorted((a, b) => automaticRank(a) - automaticRank(b))[0];
    }

    const candidates = devices.filter((d) => matches(d, want));
    if (want.match) {
      const named = candidates.find((d) => want.match!.test(d.name));
      if (named) return named;
    }
    return candidates[0];
  }

  /**
   * Wait until a device satisfying this config exists.
   *
   * Simulator and emulator discovery is not instant, and a fixed settle delay
   * either wastes time or resolves to the wrong device.
   */
  async waitForDevice(configName: string, preferred?: string, timeoutMs = 20000): Promise<Device | undefined> {
    await this.ready(500);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.#failure) throw new Error(this.#failure + '. Check your Flutter SDK / PATH; this is not a missing simulator.');
      const device = this.resolveForName(configName, preferred);
      if (device) return device;
      if (Date.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Human-readable summary of what was wanted, for error messages. */
  static describePreference(configName: string): string {
    const want = DeviceRegistry.platformFor(configName);
    if (!want) return 'any device';
    if (want.category === 'desktop') return 'a desktop device';
    const kind = want.emulator === false ? 'physical ' : want.emulator ? 'simulator/emulator ' : '';
    return `an ${want.platformType} ${kind}device`.replace('  ', ' ');
  }

  dispose(): void {
    this.#child?.kill();
    this.#child = undefined;
    this.#ready = undefined;
  }

  async #waitFor(predicate: (d: Device) => boolean, timeoutMs: number): Promise<Device | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.list().find(predicate);
      if (found) return found;
      if (Date.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  #request<T>(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.#child?.stdin) {
        reject(new Error('device daemon is not running'));
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#child.stdin.write(encodeRequest(id, method, params) + '\n');
    });
  }

  #handleResponse(response: DaemonResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.error) pending.reject(new Error(String(response.error)));
    else pending.resolve(response.result);
  }

  #handleEvent(e: DaemonEvent): void {
    if (e.event === 'device.added') {
      const p = e.params;
      this.#devices.set(p.id, {
        id: p.id,
        name: p.name,
        platform: p.platform,
        platformType: p.platformType,
        emulator: Boolean(p.emulator),
        category: p.category,
        emulatorId: p.emulatorId,
        capabilities: p.capabilities,
      });
    } else if (e.event === 'device.removed') {
      this.#devices.delete(e.params.id);
    }
  }
}

/** Stable fallback order for a target whose name does not name a platform. */
function automaticRank(device: Device): number {
  const mobile = device.platformType === 'ios' || device.platformType === 'android';
  if (mobile && device.emulator) return 0;
  if (mobile) return 1;
  if (device.platformType === 'web') return 2;
  if (device.category === 'desktop') return 3;
  return 4;
}

function matches(device: Device, want: DevicePreference): boolean {
  if (want.category && device.category !== want.category) return false;
  if (want.platformType && device.platformType !== want.platformType) return false;
  if (want.emulator !== undefined && device.emulator !== want.emulator) return false;
  return true;
}
