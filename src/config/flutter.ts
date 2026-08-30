import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export type FlutterSource = 'fvm-sdk' | 'fvm-cli' | 'path';

export type FlutterBinary = {
  /** Executable to spawn. */
  command: string;
  /** Arguments that must precede the flutter subcommand (e.g. ['flutter'] for `fvm flutter`). */
  prefixArgs: string[];
  source: FlutterSource;
  /** Version pinned by .fvmrc, when the project pins one. */
  pinnedVersion?: string;
};

type Options = {
  /** Override the `fvm` CLI probe. Injected by tests; probed from PATH otherwise. */
  hasFvmCli?: boolean;
};

function isExecutable(path: string): boolean {
  try {
    // accessSync follows symlinks, so a dangling .fvm/flutter_sdk fails here
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPinnedVersion(projectRoot: string): string | undefined {
  for (const rel of ['.fvmrc', join('.fvm', 'fvm_config.json')]) {
    const path = join(projectRoot, rel);
    if (!existsSync(path)) continue;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      // .fvmrc uses "flutter"; the older fvm_config.json uses "flutterSdkVersion"
      const v = doc.flutter ?? doc.flutterSdkVersion;
      if (typeof v === 'string') return v;
    } catch {
      // an unreadable pin file is not fatal; fall through to the next candidate
    }
  }
  return undefined;
}

function probeFvmCli(): boolean {
  try {
    execFileSync('fvm', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the Flutter binary for a project.
 *
 * Order matters: McLane360 pins 3.38.2 through FVM, and a bare `flutter` from PATH
 * is a different SDK. Using the wrong one produces confusing failures far from the
 * cause, so the project-local SDK always wins.
 */
export function resolveFlutter(projectRoot: string, options: Options = {}): FlutterBinary {
  const pinnedVersion = readPinnedVersion(projectRoot);

  const sdkBin = join(projectRoot, '.fvm', 'flutter_sdk', 'bin', 'flutter');
  if (isExecutable(sdkBin)) {
    return { command: sdkBin, prefixArgs: [], source: 'fvm-sdk', pinnedVersion };
  }

  if (pinnedVersion) {
    const hasFvm = options.hasFvmCli ?? probeFvmCli();
    if (hasFvm) {
      return { command: 'fvm', prefixArgs: ['flutter'], source: 'fvm-cli', pinnedVersion };
    }
  }

  return { command: 'flutter', prefixArgs: [], source: 'path', pinnedVersion };
}

/** Full argv for spawning, with the resolver's prefix applied. */
export function flutterSpawn(
  binary: FlutterBinary,
  argv: string[],
): { command: string; args: string[] } {
  return { command: binary.command, args: [...binary.prefixArgs, ...argv] };
}
