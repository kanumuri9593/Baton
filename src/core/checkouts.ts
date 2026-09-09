/**
 * Resolve a git checkout for a run, without moving the folder the user has open.
 *
 * Three kinds: the project folder itself, an existing linked worktree (an
 * agent's folder — never deleted), or a Baton-owned worktree of a ref, which
 * lives under `$BATON_HOME/worktrees` and is removed when the last session
 * that used it is forgotten.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { checkoutsStorePath, stateDir, worktreesDir } from './paths.ts';
import { slug } from './session-base.ts';
import { loadConfigs } from '../config/loader.ts';

export type CheckoutKind = 'inplace' | 'attached' | 'owned';

export type Checkout = {
  kind: CheckoutKind;
  sourceRoot: string;
  cwd: string;
  ref?: string;
  label: string;
};

export type CheckoutListEntry = {
  id: string;
  kind: 'inplace' | 'worktree' | 'ref';
  label: string;
  group: 'this' | 'worktrees' | 'local' | 'remote';
  ref?: string;
  cwd?: string;
};

export type GitFn = (args: string[], cwd: string) => string;

export type CheckoutPick = { branch?: string; checkout?: string };

type OwnedRecord = { sourceRoot: string; cwd: string; ref: string };

const SKIP_DIRS = new Set([
  '.git', 'build', '.dart_tool', 'node_modules', 'Pods', '.gradle', 'DerivedData',
]);

function defaultGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    throw new Error(stderr.trim() || e.message);
  }
}

function isConfigBasename(name: string): boolean {
  return (
    /^\.env/.test(name) ||
    /\.local\.json$/.test(name) ||
    /^secrets/i.test(name) ||
    name === 'google-services.json' ||
    name === 'GoogleService-Info.plist'
  );
}

type Worktree = { path: string; branch?: string };

function parseWorktreeList(text: string): Worktree[] {
  const trees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      trees.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch ')) {
      const raw = line.slice('branch '.length);
      current.branch = raw.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
    }
  }
  return trees;
}

function samePath(a: string, b: string): boolean {
  const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  try {
    const left = statSync(a, { bigint: true });
    const right = statSync(b, { bigint: true });
    if (left.dev === right.dev && left.ino === right.ino) return true;
  } catch {
    // Fall through to lexical path normalization for paths not on disk.
  }
  try {
    return comparable(realpathSync(a)) === comparable(realpathSync(b));
  } catch {
    return comparable(resolve(a)) === comparable(resolve(b));
  }
}

/**
 * Copy gitignored config (secrets, env, flavor files) from the live folder into
 * a checkout. Build caches stay behind. `overwrite` is for owned creates;
 * attach never overwrites a file the agent already has.
 */
export function copyLocalConfig(sourceRoot: string, dest: string, overwrite: boolean): void {
  const files = new Set<string>(walkConfigFiles(sourceRoot));
  for (const rel of dartDefineFiles(sourceRoot)) files.add(rel);

  for (const rel of files) {
    const from = join(sourceRoot, rel);
    const to = join(dest, rel);
    if (!existsSync(from)) continue;
    if (!overwrite && existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  linkFlutterSdk(sourceRoot, dest);
}

function walkConfigFiles(root: string, rel = ''): string[] {
  const dir = rel ? join(root, rel) : root;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkConfigFiles(root, child));
    else if (isConfigBasename(entry.name)) out.push(child);
  }
  return out;
}

function dartDefineFiles(root: string): string[] {
  const found: string[] = [];
  for (const rel of [join('.vscode', 'launch.json'), join('.claude', 'launch.json')]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    try {
      for (const config of loadConfigs(path, root)) {
        for (const arg of config.toolArgs) {
          const match = /^--dart-define-from-file[= ](.+)$/.exec(arg);
          if (match) found.push(match[1].replace(/^["']|["']$/g, ''));
        }
      }
    } catch {
      // a broken launch.json must not block a copy of .env
    }
  }
  return found;
}

function linkFlutterSdk(sourceRoot: string, dest: string): void {
  const sdk = join(sourceRoot, '.fvm', 'flutter_sdk');
  if (!existsSync(sdk)) return;
  const destSdk = join(dest, '.fvm', 'flutter_sdk');
  if (existsSync(destSdk)) return;
  mkdirSync(join(dest, '.fvm'), { recursive: true });
  try {
    symlinkSync(
      realpathSync(sdk),
      destSdk,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch {
    // A failed link is not fatal: resolveFlutter will try fvm CLI or PATH.
  }
}

export class CheckoutStore {
  #home: string;
  #git: GitFn;
  #records: OwnedRecord[];

  constructor(options: { home?: string; git?: GitFn } = {}) {
    this.#home = options.home ?? stateDir();
    this.#git = options.git ?? defaultGit;
    this.#records = this.#load();
  }

  list(sourceRoot: string, opts: { fetch?: boolean } = {}): CheckoutListEntry[] {
    const root = resolve(sourceRoot);
    const inplace: CheckoutListEntry = {
      id: 'inplace',
      kind: 'inplace',
      label: 'This checkout',
      group: 'this',
      cwd: root,
    };
    if (!this.#isRepo(root)) return [inplace];

    if (opts.fetch) {
      try { this.#git(['fetch', '--all', '--prune'], root); } catch { /* stale remotes are still listed */ }
    }

    const entries: CheckoutListEntry[] = [inplace];
    const trees = this.#worktrees(root);
    for (const tree of trees) {
      if (samePath(tree.path, root)) continue;
      const ref = tree.branch;
      entries.push({
        id: `worktree:${tree.path}`,
        kind: 'worktree',
        label: ref ? `${ref}  ·  ${basename(tree.path)}` : basename(tree.path),
        group: 'worktrees',
        ref,
        cwd: tree.path,
      });
    }

    for (const ref of this.#refs(root, 'heads')) {
      entries.push({ id: `ref:${ref}`, kind: 'ref', label: ref, group: 'local', ref });
    }
    for (const ref of this.#refs(root, 'remotes')) {
      if (ref.endsWith('/HEAD')) continue;
      entries.push({ id: `ref:${ref}`, kind: 'ref', label: ref, group: 'remote', ref });
    }
    return entries;
  }

  resolve(sourceRoot: string, pick: CheckoutPick = {}): Checkout {
    const root = resolve(sourceRoot);
    const branch = pick.branch?.trim() || undefined;
    const checkout = pick.checkout?.trim() || undefined;
    if (branch && checkout) {
      throw new Error('--branch and --checkout are mutually exclusive: pick one');
    }

    if (!branch && !checkout) {
      return { kind: 'inplace', sourceRoot: root, cwd: root, label: 'This checkout' };
    }

    if (!this.#isRepo(root)) {
      throw new Error(`${root} is not a git repository`);
    }

    if (checkout) return this.#attach(root, resolve(checkout));
    return this.#owned(root, branch!);
  }

  /**
   * Drop a Baton-owned worktree when nothing still uses it.
   *
   * Returns true when a directory was actually removed. Attached worktrees and
   * This checkout are never deleted.
   */
  release(checkout: Checkout, stillUsed: boolean): boolean {
    switch (checkout.kind) {
      case 'inplace':
      case 'attached':
        return false;
      case 'owned':
        if (stillUsed) return false;
        this.#removeWorktree(checkout.sourceRoot, checkout.cwd);
        this.#records = this.#records.filter((r) => !samePath(r.cwd, checkout.cwd));
        this.#save();
        return true;
      default: {
        const _exhaustive: never = checkout.kind;
        return _exhaustive;
      }
    }
  }

  /** Delete owned copies for a project that have no session still pointing at them. */
  releaseIdleOwned(sourceRoot: string, usedCwds: ReadonlySet<string>): string[] {
    const root = resolve(sourceRoot);
    const removed: string[] = [];
    for (const record of [...this.#records]) {
      if (resolve(record.sourceRoot) !== root) continue;
      if ([...usedCwds].some((cwd) => samePath(cwd, record.cwd))) continue;
      if (this.release({
        kind: 'owned', sourceRoot: record.sourceRoot, cwd: record.cwd, ref: record.ref, label: record.ref,
      }, false)) {
        removed.push(record.cwd);
      }
    }
    return removed;
  }

  #attach(sourceRoot: string, path: string): Checkout {
    if (!existsSync(path)) {
      throw new Error(`checkout folder is gone: ${path}`);
    }
    if (samePath(path, sourceRoot)) {
      return { kind: 'inplace', sourceRoot, cwd: sourceRoot, label: 'This checkout' };
    }
    const tree = this.#worktrees(sourceRoot).find((candidate) => samePath(candidate.path, path));
    // Git's own worktree inventory is the authority here. Comparing
    // --git-common-dir strings is unreliable on Windows, where the same path
    // can be reported using short (8.3), long, or differently cased forms.
    if (!this.#isRepo(path) || !tree) {
      throw new Error(`${path} is not a worktree of ${sourceRoot}`);
    }
    copyLocalConfig(sourceRoot, path, false);
    return {
      kind: 'attached',
      sourceRoot,
      cwd: path,
      ref: tree?.branch,
      label: tree?.branch ?? basename(path),
    };
  }

  #owned(sourceRoot: string, ref: string): Checkout {
    const existing = this.#records.find((r) =>
      resolve(r.sourceRoot) === sourceRoot && r.ref === ref && existsSync(r.cwd),
    );
    if (existing) {
      copyLocalConfig(sourceRoot, existing.cwd, false);
      return {
        kind: 'owned', sourceRoot, cwd: existing.cwd, ref, label: ref,
      };
    }

    const dest = this.#ownedPath(sourceRoot, ref);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) {
      this.#removeWorktree(sourceRoot, dest);
    }
    this.#git(['worktree', 'add', '--detach', dest, ref], sourceRoot);
    copyLocalConfig(sourceRoot, dest, true);
    this.#records.push({ sourceRoot, cwd: dest, ref });
    this.#save();
    return { kind: 'owned', sourceRoot, cwd: dest, ref, label: ref };
  }

  #ownedPath(sourceRoot: string, ref: string): string {
    const project = slug(basename(sourceRoot)) || 'project';
    const hash = createHash('sha1').update(sourceRoot).digest('hex').slice(0, 8);
    const base = this.#home === stateDir() ? worktreesDir() : join(this.#home, 'worktrees');
    mkdirSync(base, { recursive: true });
    return join(base, `${project}-${hash}`, slug(ref) || 'HEAD');
  }

  #removeWorktree(sourceRoot: string, cwd: string): void {
    try {
      this.#git(['worktree', 'remove', '--force', cwd], sourceRoot);
    } catch {
      rmSync(cwd, { recursive: true, force: true });
      try { this.#git(['worktree', 'prune'], sourceRoot); } catch { /* already gone */ }
    }
  }

  #isRepo(cwd: string): boolean {
    try {
      this.#git(['rev-parse', '--is-inside-work-tree'], cwd);
      return true;
    } catch {
      return false;
    }
  }

  #worktrees(sourceRoot: string): Worktree[] {
    try {
      return parseWorktreeList(this.#git(['worktree', 'list', '--porcelain'], sourceRoot));
    } catch {
      return [];
    }
  }

  #refs(sourceRoot: string, kind: 'heads' | 'remotes'): string[] {
    try {
      const text = this.#git(['for-each-ref', '--format=%(refname:short)', `refs/${kind}`], sourceRoot);
      return text ? text.split(/\r?\n/).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  #load(): OwnedRecord[] {
    const path = this.#storePath();
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r): r is OwnedRecord =>
        r && typeof r.sourceRoot === 'string' && typeof r.cwd === 'string' && typeof r.ref === 'string',
      );
    } catch {
      return [];
    }
  }

  #save(): void {
    try {
      writeFileSync(this.#storePath(), JSON.stringify(this.#records, null, 2));
    } catch {
      // losing the index is recoverable: the next create will just add again
    }
  }

  #storePath(): string {
    return this.#home === stateDir() ? checkoutsStorePath() : join(this.#home, 'checkouts.json');
  }
}
