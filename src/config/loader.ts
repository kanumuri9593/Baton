import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

export type ConfigKind = 'flutter' | 'process';

export type LaunchConfig = {
  /** Display name, exactly as written in launch.json. This is the user-facing handle. */
  name: string;
  kind: ConfigKind;
  request?: string;
  batonTrace?: boolean;
  batonKind?: 'web-dev' | 'react-native' | 'ios' | 'android' | 'process';
  /** Project root the config is relative to. */
  cwd: string;
  // --- flutter ---
  /** Entrypoint, e.g. lib/main.dart */
  program?: string;
  flutterMode?: 'debug' | 'profile' | 'release';
  warnings?: string[];
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
  /** Extra environment variables for the spawned child, merged over `process.env`. */
  env?: Record<string, string>;
};

type RawConfig = Record<string, unknown>;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * VS Code launch configs write `env` as a flat object, but nothing stops a
 * hand-edited one from carrying a number, boolean or null. Coerce the scalars
 * a child process env can actually hold; drop anything else silently rather
 * than fail the whole config over one bad entry.
 */
const asEnv = (v: unknown): Record<string, string> | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    out[key] = String(value);
  }
  return out;
};

/**
 * Read a launch.json (VS Code's JSONC dialect: comments and trailing commas allowed)
 * and normalise its configurations.
 *
 * The file is treated as read-only input. Baton never writes it back, so the
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

export function normalise(raw: RawConfig, cwd: string): LaunchConfig {
  // `type: dart` is how the Dart-Code extension marks a Flutter/Dart launch.
  // Anything else we can still supervise, just without hot reload.
  const kind: ConfigKind = raw.type === 'dart' ? 'flutter' : 'process';

  const expand = (value: string) => value.replaceAll('${workspaceFolder}', cwd);
  const args = asStringArray(raw.args).map(expand);
  const toolArgs = asStringArray(raw.toolArgs).map(expand);
  const appArgs: string[] = [];
  const warnings: string[] = [];
  // Older Flutter configs commonly put tool flags in args. Recognise only
  // known build flags; never guess at arbitrary application arguments.
  for (let i = 0; i < args.length; i++) {
    if (kind === 'flutter' && /^--(?:dart-define|dart-define-from-file|flavor)(?:=|$)/.test(args[i])) {
      const flag = args[i];
      toolArgs.push(flag);
      if (!flag.includes('=') && args[i + 1] && !args[i + 1].startsWith('--')) toolArgs.push(args[++i]);
      if (!warnings.length) warnings.push('Flutter build flags in args are treated as toolArgs. Move them to toolArgs for editor compatibility.');
    } else appArgs.push(args[i]);
  }
  return {
    name: raw.name as string,
    kind,
    batonTrace: raw.batonTrace === true,
    batonKind: ['web-dev', 'react-native', 'ios', 'android', 'process'].includes(raw.batonKind as string)
      ? raw.batonKind as LaunchConfig['batonKind'] : undefined,
    request: typeof raw.request === 'string' ? raw.request : undefined,
    cwd: typeof raw.cwd === 'string' ? resolve(cwd, expand(raw.cwd)) : cwd,
    flutterMode: ['debug', 'profile', 'release'].includes(raw.flutterMode as string) ? raw.flutterMode as LaunchConfig['flutterMode'] : undefined,
    warnings,
    program: typeof raw.program === 'string' ? expand(raw.program) : undefined,
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : undefined,
    toolArgs,
    args: appArgs,
    runtimeExecutable:
      typeof raw.runtimeExecutable === 'string' ? expand(raw.runtimeExecutable) : undefined,
    runtimeArgs: asStringArray(raw.runtimeArgs).map(expand),
    port: typeof raw.port === 'number' ? raw.port : undefined,
    env: asEnv(raw.env),
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
  if (config.flutterMode) argv.push('--' + config.flutterMode);
  if (config.program) argv.push('-t', config.program);
  argv.push('-d', device);
  argv.push(...config.toolArgs);
  for (const a of config.args) argv.push('--dart-entrypoint-args', a);
  return argv;
}
