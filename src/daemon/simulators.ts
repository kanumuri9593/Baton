import { execFileSync, spawn } from 'node:child_process';

/**
 * A device that is not running yet but could be started.
 *
 * The distinction matters for the picker: connected devices can be run on
 * immediately, bootables need a boot first. An IDE's device menu blends the two
 * and so does ours -- but the daemon has to know which is which.
 */
export type Bootable = {
  id: string;
  name: string;
  platformType: 'ios' | 'android';
  /** How to start it. `simctl` is a specific iOS model; `flutter` an AVD. */
  via: 'simctl' | 'flutter';
  /** Already booted, so it appears in the connected-device list too. */
  running: boolean;
  /** e.g. "iOS 26.5" -- two entries can share a name across runtimes. */
  runtime?: string;
};

export type Exec = (command: string, args: string[]) => string;

const defaultExec: Exec = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` -> `iOS 26.5` */
export function runtimeLabel(key: string): string | undefined {
  const match = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(key);
  return match ? `${match[1]} ${match[2].replace(/-/g, '.')}` : undefined;
}

/**
 * Every iOS simulator this Mac can boot, not just the ones already running.
 *
 * Flutter's own `emulator.getEmulators` collapses all of them into a single
 * generic `apple_ios_simulator` entry, which is why an IDE can only offer
 * "start a simulator" and never "start an iPhone 17 Pro Max". simctl knows the
 * real list, so ask it directly.
 */
export function listSimulators(exec: Exec = defaultExec): Bootable[] {
  if (process.platform !== 'darwin') return [];

  let parsed: any;
  try {
    parsed = JSON.parse(exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  } catch {
    return []; // no Xcode command line tools; Android and web still work
  }

  const bootables: Bootable[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    for (const device of devices as any[]) {
      if (device.isAvailable === false) continue;
      bootables.push({
        id: device.udid,
        name: device.name,
        platformType: 'ios',
        via: 'simctl',
        running: device.state === 'Booted',
        runtime: runtimeLabel(runtime),
      });
    }
  }
  return bootables;
}

/**
 * Boot one simulator by UDID and bring the Simulator app forward.
 *
 * `simctl boot` on an already-booted device is an error, not a no-op, and it is
 * a perfectly reasonable thing to ask for twice -- so treat it as success.
 */
export function bootSimulator(udid: string, exec: Exec = defaultExec): void {
  try {
    exec('xcrun', ['simctl', 'boot', udid]);
  } catch (err) {
    const message = String((err as any)?.message ?? err);
    if (!/current state: Booted|Unable to boot device in current state/i.test(message)) throw err;
  }
  spawn('open', ['-a', 'Simulator'], { stdio: 'ignore', detached: true }).unref();
}

/** One entry as `emulator.getEmulators` reports it. */
export type FlutterEmulator = {
  id: string;
  name?: string;
  category?: string;
  platformType?: string;
};

/**
 * Combine the two sources of startable devices into one list.
 *
 * Pure, because the interesting rules are all about overlap: a simulator that
 * is already booted, an AVD that is already running under a different id, and
 * Flutter's single generic `apple_ios_simulator` entry standing in for the
 * dozen real iOS models simctl just enumerated.
 */
export function mergeBootables(
  simulators: Bootable[],
  emulators: FlutterEmulator[],
  running: { deviceIds: Set<string>; emulatorIds: Set<string> },
): Bootable[] {
  const haveSimctl = simulators.length > 0;
  const fromSimctl = simulators.map((s) => ({
    ...s,
    running: s.running || running.deviceIds.has(s.id),
  }));

  const fromFlutter: Bootable[] = emulators
    .filter((e) => !(haveSimctl && e.platformType === 'ios'))
    .map((e) => ({
      id: e.id,
      name: e.name ?? e.id,
      platformType: e.platformType === 'ios' ? ('ios' as const) : ('android' as const),
      via: 'flutter' as const,
      running: running.emulatorIds.has(e.id),
    }));

  return [...fromSimctl, ...fromFlutter];
}
