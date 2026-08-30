import { readFileSync } from 'node:fs';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

export type ConfigKind = 'flutter' | 'process';

export type LaunchConfig = {
  /** Display name, exactly as written in launch.json. This is the user-facing handle. */
  name: string;
  kind: ConfigKind;
  /** Project root the config is relative to. */
  cwd: string;
  // --- flutter ---
  /** Entrypoint, e.g. lib/main.dart */
  program?: string;
  /** Explicit device from the config. When set it wins over any resolver suggestion. */
  deviceId?: string;
  /** Flutter-tool arguments, passed through verbatim and in order. */
  toolArgs: string[];
  /** Arguments forwarded to the Dart program itself. */
  args: string[];
  // --- process ---
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  port?: number;
};

type RawConfig = Record<string, unknown>;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Read a launch.json (VS Code's JSONC dialect: comments and trailing commas allowed)
 * and normalise its configurations.
 *
 * The file is treated as read-only input. CLI-Launch never writes it back, so the
 * same file keeps working in VS Code / Cursor.
 */
export function loadConfigs(path: string, cwd: string): LaunchConfig[] {
  const errors: ParseError[] = [];
  const doc = parseJsonc(readFileSync(path, 'utf8'), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as { configurations?: unknown } | undefined;

  if (errors.length > 0) {
    throw new Error(`${path}: malformed JSON at offset ${errors[0].offset}`);
  }
  if (!doc || !Array.isArray(doc.configurations)) {
    throw new Error(`${path}: no "configurations" array`);
  }

  return (doc.configurations as RawConfig[])
    .filter((raw) => raw && typeof raw === 'object' && typeof raw.name === 'string')
    .map((raw) => normalise(raw, cwd));
}

function normalise(raw: RawConfig, cwd: string): LaunchConfig {
  // `type: dart` is how the Dart-Code extension marks a Flutter/Dart launch.
  // Anything else we can still supervise, just without hot reload.
  const kind: ConfigKind = raw.type === 'dart' ? 'flutter' : 'process';

  return {
    name: raw.name as string,
    kind,
    cwd,
    program: typeof raw.program === 'string' ? raw.program : undefined,
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : undefined,
    toolArgs: asStringArray(raw.toolArgs),
    args: asStringArray(raw.args),
    runtimeExecutable:
      typeof raw.runtimeExecutable === 'string' ? raw.runtimeExecutable : undefined,
    runtimeArgs: asStringArray(raw.runtimeArgs),
    port: typeof raw.port === 'number' ? raw.port : undefined,
  };
}

/**
 * Build the argv for `flutter <argv>` running this config under the machine protocol.
 *
 * `resolvedDeviceId` is what the device resolver picked; an explicit `deviceId` in the
 * config always wins. A device is always named explicitly because `--machine` refuses
 * `-d all` (flutter_tools run.dart), and one process per device is the model anyway.
 */
export function buildFlutterArgv(config: LaunchConfig, resolvedDeviceId: string): string[] {
  if (config.kind !== 'flutter') {
    throw new Error(`buildFlutterArgv called on a ${config.kind} config: ${config.name}`);
  }

  const device = config.deviceId ?? resolvedDeviceId;
  if (!device || device === 'all') {
    throw new Error(`${config.name}: needs a single concrete device ("--machine" rejects -d all)`);
  }

  const argv = ['run', '--machine'];
  if (config.program) argv.push('-t', config.program);
  argv.push('-d', device);
  argv.push(...config.toolArgs);
  for (const a of config.args) argv.push('--dart-entrypoint-args', a);
  return argv;
}
