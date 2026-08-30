import { spawn, type ChildProcess } from 'node:child_process';
import { MachineCodec, encodeRequest, type DaemonEvent } from './protocol.ts';
import { resolveFlutter } from '../config/flutter.ts';

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
  #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#codec.on('event', (e: DaemonEvent) => this.#handleEvent(e));
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
      child.on('error', () => resolve());

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
    if (!want) return devices[0];

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
        capabilities: p.capabilities,
      });
    } else if (e.event === 'device.removed') {
      this.#devices.delete(e.params.id);
    }
  }
}

function matches(device: Device, want: DevicePreference): boolean {
  if (want.category && device.category !== want.category) return false;
  if (want.platformType && device.platformType !== want.platformType) return false;
  if (want.emulator !== undefined && device.emulator !== want.emulator) return false;
  return true;
}
