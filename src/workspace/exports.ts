import type { WorkspaceManifest } from './manifest.ts';

/** What a node's export templates can refer to. */
export type ExportContext = { name: string; url?: string };

const PLACEHOLDER = /\$\{(\w+)\}/g;

/**
 * Turn a node's declared exports into concrete env for its dependents.
 *
 * A value whose placeholder cannot be resolved is dropped rather than exported
 * with a literal `${url}` in it: a dependent that reads an obviously broken URL
 * fails in a much more confusing place than one that finds the variable unset.
 */
export function renderExports(
  exports: Record<string, string>,
  context: ExportContext,
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [key, template] of Object.entries(exports)) {
    let resolvable = true;
    const value = template.replace(PLACEHOLDER, (_match, field: string) => {
      const replacement = (context as Record<string, string | undefined>)[field];
      if (replacement === undefined) resolvable = false;
      return replacement ?? '';
    });
    if (resolvable) rendered[key] = value;
  }
  return rendered;
}

/**
 * The env one node inherits: the exports of its *direct* dependencies only.
 *
 * Exports are not transitive on purpose — a web app that talks to an API has no
 * business receiving the database URL — and later dependencies win, though
 * `validateGraph` refuses collisions before it can matter.
 */
export function dependencyEnv(
  manifest: WorkspaceManifest,
  node: string,
  urls: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const dep of manifest.nodes[node]?.dependsOn ?? []) {
    Object.assign(env, renderExports(manifest.nodes[dep].exports, { name: dep, url: urls[dep] }));
  }
  return env;
}

/** Env does not reach a Flutter app; compile-time defines do. */
export function toDartDefines(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `--dart-define=${key}=${value}`);
}
