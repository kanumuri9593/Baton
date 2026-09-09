import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { detectTargets, isProjectRoot, type DetectionDiagnostic } from './detect.ts';
import { validate } from './validate.ts';

/** Read-only discovery. Never executes project instructions or reveals env values. */
export function inspectProject(root: string) {
  const diagnostics: DetectionDiagnostic[] = [];
  const detected = detectTargets(root, diagnostics);
  const sources = ['.vscode/launch.json', '.claude/launch.json', 'package.json', 'pubspec.yaml',
    'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradlew', 'gradlew.bat']
    .filter((file) => existsSync(join(root, file)));
  try {
    sources.push(...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /\.(?:xcodeproj|xcworkspace)$/.test(entry.name))
      .map((entry) => entry.name));
  } catch { /* the missing/unreadable root is diagnosed below */ }
  const hash = createHash('sha256');
  for (const file of sources) {
    hash.update(file);
    try {
      const path = join(root, file);
      if (statSync(path).isFile()) hash.update(readFileSync(path));
    }
    catch { diagnostics.push({ file, message: 'Cannot read this source. Check file permissions.' }); }
  }
  const guidanceFiles = ['AGENTS.md', 'CLAUDE.md', 'README.md', '.baton/SKILL.md']
    .filter((file) => existsSync(join(root, file)));
  for (const directory of ['.agents/skills', '.claude/skills', '.codex/skills']) {
    try {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).slice(0, 100)) {
        const file = join(directory, entry.name, 'SKILL.md');
        if (entry.isDirectory() && existsSync(join(root, file))) guidanceFiles.push(file);
      }
    } catch { /* project-local skills are optional */ }
  }
  const children: { root: string; name: string }[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'build', 'vendor', 'dist'].includes(entry.name)) continue;
      const path = join(root, entry.name);
      if (isProjectRoot(path)) children.push({ root: path, name: entry.name });
    }
  } catch { /* missing root is reported below */ }
  if (!existsSync(root)) diagnostics.push({ file: root, message: 'Directory does not exist.' });
  const targets = detected.map((target) => ({
    name: target.name, kind: target.kind, source: target.source,
    sourceFile: target.sourceFile ?? 'pubspec.yaml', cwd: target.cwd,
    program: target.config?.program, mode: target.config?.flutterMode ?? (target.kind === 'flutter' ? 'debug' : undefined),
    deviceId: target.config?.deviceId,
    capture: target.config?.batonTrace ? 'OpenTelemetry: Node HTTP/HTTPS and fetch metadata' : undefined,
    warnings: target.config?.warnings ?? [],
    issues: target.config ? validate(target.config) : [],
    validation: target.kind === 'flutter'
      ? ['Wait for running', 'Review logs and network errors', 'Capture a simulator screenshot', 'Review the screen against the expected flow']
      : target.kind === 'ios' || target.kind === 'android'
        ? ['Wait for the native build/install to finish', 'Review compiler and deployment logs', 'Restart the process to run an incremental rebuild']
      : ['Wait for running', 'Review logs', 'Open the app URL if available', 'Exercise the flow in a browser or device'],
  }));
  return {
    root, revision: hash.digest('hex').slice(0, 16), checkedAt: new Date().toISOString(),
    sources, diagnostics, guidanceFiles, children, targets,
    steps: [
      'Choose a named environment from the detected launch targets.',
      'Choose this checkout, an existing worktree, or a branch copy.',
      'Choose a connected device or boot a simulator, then Run.',
      'Wait for readiness, exercise the intended flow, and review logs and screenshots.',
      'Use baton proof for a Flutter device/appearance matrix. A screenshot is evidence, not a visual correctness assertion.',
    ],
  };
}
export type ProjectInspection = ReturnType<typeof inspectProject>;
