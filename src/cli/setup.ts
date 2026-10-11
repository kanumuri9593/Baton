// `baton setup`: put Baton into every coding agent on this machine with one
// command. Each client keeps MCP servers in its own file and shape; this module
// knows those files, edits only the `baton` entry, and leaves the rest alone.
//
// The entry points at this install by absolute path (node + bin/baton-mcp.js),
// not at `npx`: GUI apps such as VS Code, Cursor and Claude Desktop start with a
// short PATH that often has no npx, flutter or xcrun. The shell's PATH is
// written next to it for the same reason, so the daemon the client starts can
// find the SDKs this shell can.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Launch = { command: string; args: string[]; env: Record<string, string> };
export type Shape = 'mcpServers' | 'vscode' | 'codex' | 'claude-plugin';
export type Client = {
  id: string;
  name: string;
  /** The config file, or for Claude Code the CLI it drives. */
  file: string;
  /** Present when this directory (or CLI) exists: the tool is installed. */
  marker: string;
  shape: Shape;
};
export type Outcome = { client: Client; state: 'added' | 'updated' | 'already' | 'removed' | 'absent' | 'skipped' | 'failed'; note?: string };

const TIMEOUT_SEC = 900;

/** Every client Baton knows how to configure, for this OS and home directory. */
export function clients(home = homedir(), platform = process.platform, env = process.env): Client[] {
  const appSupport =
    platform === 'darwin' ? join(home, 'Library', 'Application Support')
      : platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const claudeBin = which('claude', env);
  return [
    { id: 'claude', name: 'Claude Code', file: 'claude plugin install baton@baton', marker: claudeBin ?? join(home, '.claude'), shape: 'claude-plugin' },
    { id: 'codex', name: 'Codex', file: join(home, '.codex', 'config.toml'), marker: join(home, '.codex'), shape: 'codex' },
    { id: 'cursor', name: 'Cursor', file: join(home, '.cursor', 'mcp.json'), marker: join(home, '.cursor'), shape: 'mcpServers' },
    { id: 'vscode', name: 'VS Code (Copilot)', file: join(appSupport, 'Code', 'User', 'mcp.json'), marker: join(appSupport, 'Code', 'User'), shape: 'vscode' },
    { id: 'antigravity', name: 'Antigravity', file: join(home, '.gemini', 'antigravity', 'mcp_config.json'), marker: join(home, '.gemini', 'antigravity'), shape: 'mcpServers' },
    { id: 'gemini', name: 'Gemini CLI', file: join(home, '.gemini', 'settings.json'), marker: which('gemini', env) ?? join(home, '.gemini', 'settings.json'), shape: 'mcpServers' },
    { id: 'windsurf', name: 'Windsurf', file: join(home, '.codeium', 'windsurf', 'mcp_config.json'), marker: join(home, '.codeium', 'windsurf'), shape: 'mcpServers' },
    { id: 'claude-desktop', name: 'Claude Desktop chat', file: join(appSupport, 'Claude', 'claude_desktop_config.json'), marker: join(appSupport, 'Claude'), shape: 'mcpServers' },
  ];
}

/** How a client should start this copy of Baton. */
export function launch(packageRoot = defaultRoot(), version = packageVersion(packageRoot), env = process.env): Launch {
  const path = env.PATH ?? env.Path ?? '';
  // A copy npx unpacked into its cache can be swept away; ask npx again instead.
  if (/[\\/]_npx[\\/]/.test(packageRoot)) {
    return { command: which('npx', env) ?? 'npx', args: ['-y', `baton-run@${version}`], env: { PATH: path } };
  }
  return { command: stableNode(env), args: [join(packageRoot, 'bin', 'baton-mcp.js')], env: { PATH: path } };
}

/**
 * The `node` on PATH when it is this same binary: Homebrew's execPath sits in a
 * versioned Cellar folder that the next `brew upgrade` deletes, while
 * /opt/homebrew/bin/node follows the upgrade.
 */
function stableNode(env: NodeJS.ProcessEnv): string {
  const onPath = which('node', env);
  try {
    if (onPath && realpathSync(onPath) === realpathSync(process.execPath)) return onPath;
  } catch { /* fall through */ }
  return process.execPath;
}

/** The `baton` entry each shape stores. */
export function entry(shape: Shape, l: Launch): Record<string, unknown> {
  if (shape === 'vscode') return { type: 'stdio', command: l.command, args: l.args, env: l.env };
  if (shape === 'mcpServers') return { command: l.command, args: l.args, env: l.env, timeout: TIMEOUT_SEC * 1000 };
  return { command: l.command, args: l.args, env: l.env };
}

/** Add, replace or remove the `baton` server in a JSON config's text. */
export function editJson(text: string | undefined, shape: 'mcpServers' | 'vscode', l: Launch | null): { text: string; changed: boolean; had: boolean } {
  const doc = text && text.trim() ? JSON.parse(text) : {};
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('is not a JSON object');
  const key = shape === 'vscode' ? 'servers' : 'mcpServers';
  const servers = (doc[key] ??= {}) as Record<string, unknown>;
  const had = 'baton' in servers;
  const before = JSON.stringify(servers.baton);
  if (l) servers.baton = entry(shape, l);
  else delete servers.baton;
  return { text: JSON.stringify(doc, null, 2) + '\n', changed: JSON.stringify(servers.baton) !== before, had };
}

const toml = (s: string) => JSON.stringify(s);

/** Add, replace or remove `[mcp_servers.baton]` in Codex's config.toml, keeping every other line. */
export function editToml(text: string | undefined, l: Launch | null): { text: string; changed: boolean; had: boolean } {
  const lines = (text ?? '').split('\n');
  const out: string[] = [];
  let skipping = false;
  let had = false;
  for (const line of lines) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) skipping = header[1] === 'mcp_servers.baton' || header[1]!.startsWith('mcp_servers.baton.');
    if (skipping) { had = true; continue; }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  if (l) {
    out.push(
      '', '[mcp_servers.baton]',
      `command = ${toml(l.command)}`,
      `args = [${l.args.map(toml).join(', ')}]`,
      `tool_timeout_sec = ${TIMEOUT_SEC}`,
      '', '[mcp_servers.baton.env]',
      ...Object.entries(l.env).map(([k, v]) => `${k} = ${toml(v)}`),
    );
  }
  const next = out.join('\n') + '\n';
  return { text: next, changed: next !== (text ?? ''), had };
}

export type SetupOptions = { only?: string[]; remove?: boolean; dryRun?: boolean; home?: string; launch?: Launch; run?: (cmd: string, args: string[]) => string };

/** Configure (or with `remove`, unconfigure) every installed client, or the ones named. */
export function setup(opts: SetupOptions = {}): Outcome[] {
  const all = clients(opts.home);
  const unknown = (opts.only ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown client: ${unknown.join(', ')} (one of ${all.map((c) => c.id).join(', ')})`);
  const picked = opts.only?.length ? all.filter((c) => opts.only!.includes(c.id)) : all;
  const l = opts.remove ? null : (opts.launch ?? launch());
  const run = opts.run ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }));

  return picked.map((client): Outcome => {
    if (!existsSync(client.marker)) return { client, state: 'absent' };
    try {
      if (client.shape === 'claude-plugin') return claudePlugin(client, !!opts.remove, !!opts.dryRun, run);
      const current = existsSync(client.file) ? readFileSync(client.file, 'utf8') : undefined;
      let edited;
      try {
        edited = client.shape === 'codex' ? editToml(current, l) : editJson(current, client.shape as 'mcpServers' | 'vscode', l);
      } catch (err) {
        return { client, state: 'skipped', note: `${client.file} ${(err as Error).message.includes('JSON') ? 'is not plain JSON (comments?); add Baton by hand' : (err as Error).message}` };
      }
      if (!edited.changed) return { client, state: opts.remove ? 'absent' : 'already' };
      if (!opts.dryRun) {
        mkdirSync(dirname(client.file), { recursive: true });
        if (current !== undefined) copyFileSync(client.file, client.file + '.baton-backup');
        writeFileSync(client.file, edited.text);
      }
      return { client, state: opts.remove ? 'removed' : edited.had ? 'updated' : 'added' };
    } catch (err) {
      return { client, state: 'failed', note: (err as Error).message.split('\n')[0] };
    }
  });
}

/** Claude Code gets the plugin, not a bare server: it adds the skill, /baton and the band. */
function claudePlugin(client: Client, remove: boolean, dryRun: boolean, run: (cmd: string, args: string[]) => string): Outcome {
  const claude = which('claude') ?? 'claude';
  const installed = /baton@baton/.test(run(claude, ['plugin', 'list']));
  if (remove) {
    if (!installed) return { client, state: 'absent' };
    if (!dryRun) run(claude, ['plugin', 'uninstall', 'baton@baton']);
    return { client, state: 'removed' };
  }
  if (installed) return { client, state: 'already', note: 'plugin installed' };
  if (!dryRun) {
    run(claude, ['plugin', 'marketplace', 'add', 'kanumuri9593/Baton']);
    run(claude, ['plugin', 'install', 'baton@baton']);
  }
  return { client, state: 'added', note: 'plugin' };
}

function which(name: string, env = process.env): string | undefined {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    for (const ext of exts) {
      const candidate = dir && join(dir, name + ext);
      if (candidate && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function defaultRoot(): string {
  // src/cli/setup.ts and dist/cli/setup.js both sit two levels under the package.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function packageVersion(root: string): string {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    return 'latest';
  }
}
