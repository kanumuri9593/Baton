import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isProjectRoot } from '../config/detect.ts';

/**
 * Browsing the filesystem from the HUD.
 *
 * Opening a project should not require typing an absolute path from memory, and
 * a browser page cannot open a native file dialog that gives the daemon a path.
 * So the daemon does the listing: one directory at a time, annotated with what
 * the HUD needs to show ("this one is a project", "this one already has a
 * launch config") so the user can recognise the right folder instead of
 * remembering it.
 *
 * A pure function over a path, kept out of `server.ts` so it can be tested
 * without a daemon. It never throws -- every failure is a readable `error` with
 * the rest of the result still filled in, because a modal that dead-ends on an
 * unreadable folder is worse than one that says "permission denied" and still
 * offers the way back out.
 */

export type BrowseEntry = {
  name: string;
  path: string;
  /** Looks like a project root by the same markers `findProjectRoot` walks for. */
  isProject: boolean;
  /** Already has a `.vscode/launch.json` or `.claude/launch.json`. */
  hasLaunchJson: boolean;
};

export type BrowseShortcut = { label: string; path: string };

export type BrowseResult = {
  path: string;
  /** The directory above, absent only at the filesystem root. */
  parent?: string;
  entries: BrowseEntry[];
  shortcuts: BrowseShortcut[];
  /** Set when the directory could not be listed; `entries` is then empty. */
  error?: string;
};

/** A HUD list is for picking, not for scrolling; past this a filter is the answer. */
const MAX_ENTRIES = 500;

/** Where people actually keep code, in the order they would look. */
const HOME_SHORTCUTS = ['Desktop', 'Documents', 'code', 'dev', 'Projects'];

export function browseDirs(path?: string): BrowseResult {
  // Reached straight off the wire, so what arrives is checked rather than
  // trusted: `{path: 123}` must answer like everything else, not throw a
  // TypeError out of a function whose whole contract is that it never throws.
  // A blank path means home, not `resolve('')` -- that is the daemon's own
  // working directory, an accident of wherever it happened to be started.
  const asked = path === undefined || path === null ? '' : String(path).trim();
  const target = asked ? expand(asked) : homedir();
  const parent = dirname(target);
  const base: BrowseResult = {
    path: target,
    parent: parent === target ? undefined : parent,
    entries: [],
    shortcuts: shortcuts(),
  };

  let stats;
  try {
    stats = statSync(target);
  } catch {
    return { ...base, error: `no such directory: ${target}` };
  }
  // Deliberately not "helpfully" browsing the file's parent instead: a path that
  // is a file is either a typo or a mis-click, and quietly going somewhere else
  // hides which.
  if (!stats.isDirectory()) return { ...base, error: 'not a directory' };

  let dirents;
  try {
    dirents = readdirSync(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return { ...base, error: 'permission denied' };
    return { ...base, error: (err as Error).message };
  }

  const entries = dirents
    // Dot-directories are configuration, not places to open a project from.
    .filter((d) => !d.name.startsWith('.') && isDirectory(target, d))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_ENTRIES)
    .map((name) => {
      const full = join(target, name);
      return {
        name,
        path: full,
        isProject: safely(() => isProjectRoot(full), false),
        hasLaunchJson: safely(() => hasLaunchJson(full), false),
      };
    });

  return { ...base, entries };
}

/** `~/code` from a manual-path box means the same thing it does in a shell. */
function expand(trimmed: string): string {
  const home = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? join(homedir(), trimmed.slice(1))
    : trimmed;
  return resolve(home);
}

/**
 * A symlink to a directory is a directory here.
 *
 * `~/code` pointing at a volume is common enough that treating it as "not a
 * directory" would make the browser useless on exactly the machines that need
 * it. A broken link resolves to nothing and is dropped.
 */
function isDirectory(parent: string, dirent: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  return safely(() => statSync(join(parent, dirent.name)).isDirectory(), false);
}

const hasLaunchJson = (dir: string): boolean =>
  existsSync(join(dir, '.vscode', 'launch.json')) || existsSync(join(dir, '.claude', 'launch.json'));

/** One unreadable entry must not cost the reader the other 499. */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The jump targets offered alongside the listing.
 *
 * Home first, then the folders this machine actually has -- an offer to visit a
 * `~/Projects` that does not exist is noise. Mounted volumes matter on macOS
 * (external drives are where the big checkouts live) and drive letters on
 * Windows, where "Home" alone cannot reach `D:`.
 */
function shortcuts(): BrowseShortcut[] {
  const home = homedir();
  const out: BrowseShortcut[] = [{ label: 'Home', path: home }];
  const add = (label: string, path: string) => {
    if (path === home || out.some((s) => s.path === path)) return;
    if (safely(() => existsSync(path), false)) out.push({ label, path });
  };

  for (const name of HOME_SHORTCUTS) add(name, join(home, name));

  if (process.platform === 'darwin') {
    for (const name of safely(() => readdirSync('/Volumes'), [] as string[])) {
      add(name, join('/Volumes', name));
    }
  } else if (process.platform === 'win32') {
    // A..B are historically floppy drives and probing them can stall for
    // seconds on some machines; C onwards is every drive anyone actually mounts.
    for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
      const letter = String.fromCharCode(code);
      add(`${letter}:`, `${letter}:\\`);
    }
  } else {
    add('/', '/');
  }

  return out;
}
