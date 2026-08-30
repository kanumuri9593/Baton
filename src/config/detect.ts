import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigs, type LaunchConfig } from './loader.ts';

export type TargetKind = 'flutter' | 'web-dev' | 'react-native' | 'process';

export type Target = {
  /** Unique, human-typeable name. */
  name: string;
  kind: TargetKind;
  /** Where this target was discovered, shown so the list is never mysterious. */
  source: 'launch.json' | 'package.json' | 'auto';
  cwd: string;
  /** Present for launch.json-derived targets. */
  config?: LaunchConfig;
  /** Present for script/command targets. */
  command?: string;
  args?: string[];
};

/** npm/yarn/pnpm/bun, chosen by the lockfile actually present. */
export function detectPackageManager(root: string): { command: string; runPrefix: string[] } {
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) {
    return { command: 'bun', runPrefix: ['run'] };
  }
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return { command: 'pnpm', runPrefix: ['run'] };
  if (existsSync(join(root, 'yarn.lock'))) return { command: 'yarn', runPrefix: ['run'] };
  return { command: 'npm', runPrefix: ['run'] };
}

function readJson(path: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Dev-server scripts worth surfacing, in the order people expect them. */
const DEV_SCRIPTS = ['dev', 'start', 'serve', 'develop', 'dev:web', 'storybook'];

const WEB_FRAMEWORK_DEPS = [
  'next', 'vite', 'nuxt', 'astro', '@remix-run/dev', '@angular/cli',
  'react-scripts', '@sveltejs/kit', 'gatsby', 'parcel', 'webpack-dev-server',
];

/**
 * Work out what can be run in a project, without requiring any CLI-Launch config.
 *
 * Explicit launch.json entries win, because someone wrote them deliberately.
 * Everything else is inferred so a fresh clone is useful immediately.
 */
export function detectTargets(root: string): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  const add = (t: Target) => {
    if (seen.has(t.name)) return;
    seen.add(t.name);
    targets.push(t);
  };

  // 1. Explicit launch configurations, from either editor convention.
  for (const rel of [join('.vscode', 'launch.json'), join('.claude', 'launch.json')]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    let configs: LaunchConfig[];
    try {
      configs = loadConfigs(path, root);
    } catch {
      continue; // a malformed launch.json must not block detection of everything else
    }
    for (const config of configs) {
      if (config.kind === 'flutter') {
        add({ name: config.name, kind: 'flutter', source: 'launch.json', cwd: root, config });
      } else if (config.runtimeExecutable) {
        add({
          name: config.name,
          kind: 'process',
          source: 'launch.json',
          cwd: root,
          command: config.runtimeExecutable,
          args: config.runtimeArgs ?? [],
          config,
        });
      }
    }
  }

  // 2. Flutter projects without a launch.json still have an obvious default run.
  const pubspec = join(root, 'pubspec.yaml');
  if (existsSync(pubspec) && /^\s*flutter\s*:/m.test(readFileSync(pubspec, 'utf8'))) {
    add({
      name: 'flutter run',
      kind: 'flutter',
      source: 'auto',
      cwd: root,
      config: {
        name: 'flutter run', kind: 'flutter', cwd: root,
        program: existsSync(join(root, 'lib', 'main.dart')) ? 'lib/main.dart' : undefined,
        toolArgs: [], args: [],
      },
    });
  }

  // 3. Node projects: dev scripts, classified by the framework in use.
  const pkg = readJson(join(root, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const pm = detectPackageManager(root);
    const isReactNative = Boolean(deps['react-native']) || existsSync(join(root, 'app.json'));
    const isWeb = WEB_FRAMEWORK_DEPS.some((d) => deps[d]);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;

    for (const script of DEV_SCRIPTS) {
      if (!scripts[script]) continue;
      const body = scripts[script];
      const kind: TargetKind =
        /react-native start|expo start|metro/i.test(body) || (isReactNative && script === 'start')
          ? 'react-native'
          : isWeb || /next|vite|nuxt|astro|remix|ng serve|webpack|parcel/i.test(body)
            ? 'web-dev'
            : 'process';

      add({
        name: `${pm.command} ${script}`,
        kind,
        source: 'package.json',
        cwd: root,
        command: pm.command,
        args: [...pm.runPrefix, script],
      });
    }
  }

  return targets;
}

/** Find the nearest ancestor that looks like a project root. */
export function findProjectRoot(start: string): string {
  const markers = ['pubspec.yaml', 'package.json', '.vscode', '.git'];
  let dir = start;
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) return start;
    dir = parent;
  }
}
