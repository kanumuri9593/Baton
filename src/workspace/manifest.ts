import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';

/** The committed file name. One per umbrella folder. */
export const MANIFEST_FILE = 'baton.workspace.json';

const MAX_NODES = 24;

const targetRefSchema = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1),
  branch: z.string().optional(),
  checkout: z.string().optional(),
  device: z.string().optional(),
}).strict().refine((t) => !(t.branch && t.checkout), 'branch and checkout are mutually exclusive');

const composeRefSchema = z.object({
  file: z.string().min(1),
  service: z.string().min(1),
}).strict();

const remoteRefSchema = z.object({ url: z.string().min(1) }).strict();

const probeSchema = z.union([
  z.object({ tcp: z.number().int().min(1).max(65535) }).strict(),
  z.object({ http: z.string().min(1), status: z.number().int().min(100).max(599).optional() }).strict(),
  z.object({ log: z.string().min(1) }).strict(),
]);

const readySchema = z.union([z.enum(['running', 'url']), probeSchema]);

const providerSchema = z.object({
  target: targetRefSchema.optional(),
  compose: composeRefSchema.optional(),
  remote: remoteRefSchema.optional(),
  /** An explicit URL, when readiness alone cannot tell Baton where the node lives. */
  url: z.string().min(1).optional(),
  ready: readySchema.optional(),
  timeoutMs: z.number().int().min(1).max(300000).default(60000),
}).strict().refine(
  (p) => [p.target, p.compose, p.remote].filter(Boolean).length === 1,
  'a provider must declare exactly one of target, compose or remote',
);

const nodeSchema = z.object({
  kind: z.enum(['backend', 'web', 'mobile', 'datastore', 'queue', 'other']).default('other'),
  dependsOn: z.array(z.string().min(1)).default([]),
  providers: z.record(z.string().min(1), providerSchema),
  exports: z.record(z.string().min(1), z.string()).default({}),
}).strict().refine((n) => Object.keys(n.providers).length > 0, 'a node needs at least one provider');

export const manifestSchema = z.object({
  name: z.string().min(1).max(100),
  nodes: z.record(z.string().min(1), nodeSchema),
  /** The team's default provider per node, committed alongside the manifest. */
  defaults: z.record(z.string().min(1), z.string().min(1)).default({}),
}).strict();

export type WorkspaceManifest = z.infer<typeof manifestSchema>;
export type WorkspaceNode = WorkspaceManifest['nodes'][string];
export type WorkspaceProvider = WorkspaceNode['providers'][string];
export type Probe = z.infer<typeof probeSchema>;
export type Readiness = z.infer<typeof readySchema>;

/**
 * Validate a manifest and resolve every path in it against the manifest's own
 * directory, so a committed file means the same thing on every machine.
 *
 * Graph-level checks (dependencies, cycles, export collisions) live in
 * `graph.ts` and run separately: this function answers "is this file shaped
 * like a manifest", not "does this system make sense".
 */
export function parseManifest(input: unknown, baseDir: string): WorkspaceManifest {
  const manifest = manifestSchema.parse(input);
  const names = Object.keys(manifest.nodes);
  if (names.length === 0) throw new Error('a workspace needs at least one node');
  if (names.length > MAX_NODES) {
    throw new Error(`a workspace is limited to ${MAX_NODES} nodes; this one declares ${names.length}`);
  }

  for (const node of Object.values(manifest.nodes)) {
    for (const provider of Object.values(node.providers)) {
      if (provider.target) {
        provider.target.cwd = resolve(baseDir, provider.target.cwd);
        if (provider.target.checkout) provider.target.checkout = resolve(baseDir, provider.target.checkout);
      }
      // A compose file is a path; a remote URL never is.
      if (provider.compose) provider.compose.file = resolve(baseDir, provider.compose.file);
    }
  }

  for (const [node, provider] of Object.entries(manifest.defaults)) {
    const declared = manifest.nodes[node];
    if (!declared) throw new Error(`defaults name "${node}", which is not a node in this workspace`);
    if (!declared.providers[provider]) {
      throw new Error(
        `defaults set ${node} to "${provider}", but ${node} offers ${Object.keys(declared.providers).join(', ')}`,
      );
    }
  }
  return manifest;
}

/**
 * Canonical form of a path: symlinks resolved, so one manifest is one workspace.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, and checkouts are routinely
 * reached through symlinked paths. Without this, `baton up /tmp/x` and a
 * `baton switch` run from inside that same directory disagree about which
 * workspace they mean, and the second one finds nothing.
 */
export function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path); // does not exist yet; the caller reports that better
  }
}

/**
 * The manifest governing a path: the file itself, the one in that directory, or
 * the nearest one above it — so `baton up` works from inside `./api` too.
 */
export function findManifest(start: string): string | undefined {
  const from = canonical(start);
  let dir = from;
  try {
    if (statSync(from).isFile()) return from;
  } catch {
    return undefined; // nothing at that path to search from
  }
  for (;;) {
    const candidate = join(dir, MANIFEST_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export type LoadedManifest = { manifest: WorkspaceManifest; manifestPath: string; root: string };

/** Find, read and parse in one step. Throws with the path when there is none. */
export function readManifest(start: string): LoadedManifest {
  const manifestPath = findManifest(start);
  if (!manifestPath) {
    throw new Error(`no ${MANIFEST_FILE} in ${resolve(start)} or any directory above it`);
  }
  const root = dirname(manifestPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${(error as Error).message}`);
  }
  try {
    return { manifest: parseManifest(raw, root), manifestPath, root };
  } catch (error) {
    throw new Error(`${manifestPath}: ${(error as Error).message}`);
  }
}

/**
 * Which provider to use for a node.
 *
 * Precedence is most specific first: this call's override, then what this
 * machine last chose, then the team default, then the only provider there is.
 * A node with several providers and no default is ambiguous, and Baton says so
 * rather than picking one.
 */
export function chosenProvider(
  manifest: WorkspaceManifest,
  node: string,
  overrides: Record<string, string> = {},
  persisted: Record<string, string> = {},
): string {
  const declared = manifest.nodes[node];
  if (!declared) throw new Error(`"${node}" is not a node in this workspace`);
  const offered = Object.keys(declared.providers);

  for (const [source, name] of [
    ['--provider', overrides[node]],
    ['this machine\'s saved choice', persisted[node]],
    ['the workspace defaults', manifest.defaults[node]],
  ] as const) {
    if (!name) continue;
    if (!declared.providers[name]) {
      throw new Error(`${source} sets ${node} to "${name}", but ${node} offers ${offered.join(', ')}`);
    }
    return name;
  }

  if (offered.length === 1) return offered[0];
  throw new Error(
    `${node} offers ${offered.join(', ')} and has no default; choose one with --provider ${node}=${offered[0]}`,
  );
}
