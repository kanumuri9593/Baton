import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LaunchConfig } from './loader.ts';

export type ValidationIssue = { kind: 'missing-file'; path: string; hint: string };

/**
 * Check a config before spawning anything.
 *
 * `--dart-define-from-file` pointing at a missing file makes `flutter run` fail
 * with an error far from the cause, and these files are routinely gitignored
 * (secrets, per-developer overrides) so a fresh clone hits it immediately.
 * Naming the missing path up front turns a confusing failure into a one-line fix.
 */
export function validate(config: LaunchConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (let i = 0; i < config.toolArgs.length; i++) {
    const arg = config.toolArgs[i] === '--dart-define-from-file'
      ? '--dart-define-from-file=' + (config.toolArgs[++i] ?? '')
      : config.toolArgs[i];
    const match = /^--dart-define-from-file[= ](.+)$/.exec(arg);
    if (!match) continue;

    const relative = match[1].replace(/^["']|["']$/g, '');
    const path = isAbsolute(relative) ? relative : join(config.cwd, relative);
    if (existsSync(path)) continue;

    // These files usually ship with a .template.json sibling to copy from.
    const template = path.replace(/\.json$/, '.template.json');
    issues.push({
      kind: 'missing-file',
      path: relative,
      hint: existsSync(template)
        ? `copy ${template.replace(config.cwd + '/', '')} to ${relative}`
        : `create ${relative}, or drop it from this config`,
    });
  }

  return issues;
}

/** True when nothing blocks this config from running. */
export function isRunnable(config: LaunchConfig): boolean {
  return validate(config).length === 0;
}
