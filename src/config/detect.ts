import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { loadConfigs, type LaunchConfig } from './loader.ts';

export type TargetKind = 'flutter' | 'web-dev' | 'react-native' | 'ios' | 'android' | 'process';

export type Target = {
  /** Unique, human-typeable name. */
  name: string;
  kind: TargetKind;
  /** Where this target was discovered, shown so the list is never mysterious. */
  source: 'launch.json' | 'package.json' | 'auto';
  sourceFile?: string;
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

const IOS_CONTAINER_EXTENSIONS = new Set(['.xcodeproj', '.xcworkspace']);
const ANDROID_PROJECT_FILES = new Set([
  'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts',
  'gradlew', 'gradlew.bat', 'AndroidManifest.xml',
]);

const safelyReadDir = (dir: string) => {
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
};

/** Files and directory bundles a person is likely to select as a native project. */
export function isNativeProjectSelection(path: string): boolean {
  const name = basename(path);
  return IOS_CONTAINER_EXTENSIONS.has(extname(name)) || ANDROID_PROJECT_FILES.has(name);
}

function iosContainers(root: string): string[] {
  return safelyReadDir(root)
    .filter((entry) => entry.isDirectory() && IOS_CONTAINER_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => entry.name)
    .filter((name) => name !== 'Pods.xcodeproj')
    .sort((a, b) => {
      // A workspace normally carries CocoaPods/SPM integration and is the thing
      // Xcode itself opens, so prefer it when both forms are present.
      const rank = (value: string) => value.endsWith('.xcworkspace') ? 0 : 1;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
}

function sharedSchemes(root: string, containers: string[]): string[] {
  const names = new Set<string>();
  for (const container of containers) {
    const dir = join(root, container, 'xcshareddata', 'xcschemes');
    for (const entry of safelyReadDir(dir)) {
      if (entry.isFile() && entry.name.endsWith('.xcscheme')) names.add(entry.name.slice(0, -'.xcscheme'.length));
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function androidApplicationModules(root: string): string[] {
  const modules: string[] = [];
  const candidates = [{ name: '', path: root }, ...safelyReadDir(root)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))];
  for (const candidate of candidates) {
    for (const file of ['build.gradle', 'build.gradle.kts']) {
      try {
        const text = readFileSync(join(candidate.path, file), 'utf8');
        if (/com\.android\.application/.test(text)) modules.push(candidate.name);
        break;
      } catch { /* this candidate simply has no readable Gradle build file */ }
    }
  }
  return [...new Set(modules)];
}

/**
 * Work out what can be run in a project, without requiring any Baton config.
 *
 * Explicit launch.json entries win, because someone wrote them deliberately.
 * Everything else is inferred so a fresh clone is useful immediately.
 */
export type DetectionDiagnostic = { file: string; message: string };

export function detectTargets(root: string, diagnostics: DetectionDiagnostic[] = []): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  const add = (t: Target) => {
    if (seen.has(t.name)) {
      diagnostics.push({ file: t.sourceFile ?? t.source, message: `Duplicate target "${t.name}" is shadowed by an earlier source. Rename it to make both selectable.` });
      return;
    }
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
    } catch (err) {
      diagnostics.push({ file: rel, message: (err as Error).message });
      continue; // a malformed launch.json must not block detection of everything else
    }
    for (const config of configs) {
      if (config.request === 'attach') {
        diagnostics.push({ file: rel, message: `"${config.name}" is an attach configuration. Baton currently starts new processes; choose a launch configuration.` });
        continue;
      }
      if (config.kind === 'flutter') {
        add({ name: config.name, kind: 'flutter', source: 'launch.json', sourceFile: rel, cwd: config.cwd, config });
      } else if (config.runtimeExecutable) {
        add({
          name: config.name,
          kind: config.batonKind ?? 'process',
          source: 'launch.json',
          sourceFile: rel,
          cwd: config.cwd,
          command: config.runtimeExecutable,
          args: [...(config.runtimeArgs ?? []), ...(config.program ? [config.program] : []), ...config.args],
          config,
        });
      } else {
        diagnostics.push({ file: rel, message: `"${config.name}" has no supported runtimeExecutable. Add an explicit command to launch it with Baton.` });
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

    for (const script of new Set([...DEV_SCRIPTS, ...Object.keys(scripts).filter((s) => /^(dev|start|serve):/.test(s))])) {
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
        sourceFile: 'package.json',
        cwd: root,
        command: pm.command,
        args: [...pm.runPrefix, script],
      });
    }
  }

  // 4. Native iOS projects. Xcode has no general-purpose hot-reload protocol,
  // but an incremental simulator build is still useful and honestly supervised.
  const containers = iosContainers(root);
  if (containers.length) {
    const container = containers[0];
    const schemes = sharedSchemes(root, containers);
    const fallback = basename(containers.find((name) => name.endsWith('.xcodeproj')) ?? container, extname(container));
    for (const scheme of schemes.length ? schemes : [fallback]) {
      add({
        name: `iOS Simulator · ${scheme}`,
        kind: 'ios',
        source: 'auto',
        sourceFile: container,
        cwd: root,
        command: 'xcodebuild',
        args: [
          container.endsWith('.xcworkspace') ? '-workspace' : '-project', container,
          '-scheme', scheme, '-configuration', 'Debug',
          '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', 'build',
        ],
      });
    }
  }

  // 5. Native Android projects. installDebug performs Gradle's incremental
  // build and deploys to a connected device/emulator; process restart repeats it.
  const androidRoot = ['settings.gradle', 'settings.gradle.kts', 'gradlew', 'gradlew.bat']
    .some((file) => existsSync(join(root, file)));
  if (androidRoot) {
    const sourceFile = ['settings.gradle.kts', 'settings.gradle', 'gradlew', 'gradlew.bat']
      .find((file) => existsSync(join(root, file)))!;
    const wrapper = process.platform === 'win32' && existsSync(join(root, 'gradlew.bat'))
      ? join(root, 'gradlew.bat')
      : existsSync(join(root, 'gradlew')) ? join(root, 'gradlew') : 'gradle';
    const modules = androidApplicationModules(root);
    if (modules.length) {
      for (const module of modules) {
        add({
          name: `Android · ${module || basename(root)} debug`,
          kind: 'android', source: 'auto',
          sourceFile,
          cwd: root, command: wrapper,
          args: [module ? `:${module}:installDebug` : 'installDebug'],
        });
      }
    } else {
      add({
        name: 'Android · Gradle build', kind: 'android', source: 'auto',
        sourceFile,
        cwd: root, command: wrapper, args: ['build'],
      });
    }
  }

  return targets;
}

const PROJECT_MARKERS = [
  'pubspec.yaml', 'package.json', '.vscode', '.claude', '.git',
  'settings.gradle', 'settings.gradle.kts', 'gradlew', 'gradlew.bat',
];

/** Whether a directory is a project at all, regardless of what it can run. */
export function isProjectRoot(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(dir, m))) || iosContainers(dir).length > 0;
}

/** Find the nearest ancestor that looks like a project root. */
export function findProjectRoot(start: string): string {
  const markers = PROJECT_MARKERS;
  let dir = start;
  let fallback = start;
  try {
    if (statSync(dir).isFile() || IOS_CONTAINER_EXTENSIONS.has(extname(dir))) dir = dirname(dir);
  } catch {
    if (isNativeProjectSelection(dir)) dir = dirname(dir);
  }
  fallback = dir;
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m))) || iosContainers(dir).length > 0) return dir;
    const parent = join(dir, '..');
    if (parent === dir) return fallback;
    dir = parent;
  }
}
