import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { editJson, editToml, launch, setup, type Launch } from '../src/cli/setup.ts';

const L: Launch = { command: '/usr/local/bin/node', args: ['/opt/baton/bin/baton-mcp.js'], env: { PATH: '/opt/homebrew/bin:/usr/bin' } };

test('launch points at this install, or at npx for a copy in the npx cache', () => {
  const local = launch('/opt/baton', '0.2.9', { PATH: '/usr/bin' });
  assert.equal(local.command, process.execPath);
  const linked = launch('/opt/baton', '0.2.9', { PATH: dirname(process.execPath) });
  assert.equal(dirname(linked.command), dirname(process.execPath));
  assert.equal(realpathSync(linked.command), realpathSync(process.execPath));
  assert.deepEqual(local.args, ['/opt/baton/bin/baton-mcp.js']);
  assert.deepEqual(local.env, { PATH: '/usr/bin' });
  const npx = launch('/home/me/.npm/_npx/ab12/node_modules/baton-run', '0.2.9', { PATH: '/usr/bin' });
  assert.deepEqual(npx.args, ['-y', 'baton-run@0.2.9']);
});

test('editJson keeps other servers and keys, and is idempotent', () => {
  const start = JSON.stringify({ theme: 'dark', mcpServers: { dart: { command: 'dart' } } });
  const once = editJson(start, 'mcpServers', L);
  assert.equal(once.changed, true);
  assert.equal(once.had, false);
  const doc = JSON.parse(once.text);
  assert.equal(doc.theme, 'dark');
  assert.deepEqual(doc.mcpServers.dart, { command: 'dart' });
  assert.equal(doc.mcpServers.baton.command, L.command);
  assert.equal(doc.mcpServers.baton.timeout, 900_000);
  assert.equal(editJson(once.text, 'mcpServers', L).changed, false);
  const removed = JSON.parse(editJson(once.text, 'mcpServers', null).text);
  assert.equal(removed.mcpServers.baton, undefined);
  assert.deepEqual(removed.mcpServers.dart, { command: 'dart' });
});

test('VS Code gets a typed stdio entry under "servers"', () => {
  const doc = JSON.parse(editJson(undefined, 'vscode', L).text);
  assert.deepEqual(doc.servers.baton, { type: 'stdio', command: L.command, args: L.args, env: L.env });
});

test('editToml replaces only the baton tables in Codex config', () => {
  const start = [
    'model = "gpt"', '',
    '[mcp_servers.playwright]', 'command = "npx"', '',
    '[mcp_servers.baton]', 'command = "old"', '',
    '[mcp_servers.baton.env]', 'PATH = "/old"', '',
    '[mcp_servers.figma]', 'url = "https://mcp.figma.com/mcp"', '',
  ].join('\n');
  const { text, had } = editToml(start, L);
  assert.equal(had, true);
  assert.doesNotMatch(text, /old/);
  assert.match(text, /\[mcp_servers\.playwright\]\ncommand = "npx"/);
  assert.match(text, /\[mcp_servers\.figma\]\nurl = /);
  assert.match(text, /\[mcp_servers\.baton\]\ncommand = "\/usr\/local\/bin\/node"\nargs = \["\/opt\/baton\/bin\/baton-mcp\.js"\]\ntool_timeout_sec = 900/);
  assert.match(text, /\[mcp_servers\.baton\.env\]\nPATH = "\/opt\/homebrew\/bin:\/usr\/bin"/);
  assert.equal(editToml(text, L).changed, false);
  assert.doesNotMatch(editToml(text, null).text, /baton/);
});

test('setup writes only installed clients, backs files up, and removes cleanly', () => {
  const home = mkdtempSync(join(tmpdir(), 'baton-setup-'));
  mkdirSync(join(home, '.cursor'));
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { dart: { command: 'dart' } } }));
  mkdirSync(join(home, '.codex'));
  mkdirSync(join(home, '.gemini', 'antigravity'), { recursive: true });
  const run = () => '';

  const out = setup({ home, launch: L, run, only: ['cursor', 'codex', 'antigravity', 'windsurf'] });
  assert.deepEqual(out.map((o) => [o.client.id, o.state]), [['codex', 'added'], ['cursor', 'added'], ['antigravity', 'added'], ['windsurf', 'absent']]);
  assert.ok(existsSync(join(home, '.cursor', 'mcp.json.baton-backup')));
  assert.match(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.baton\]/);
  assert.equal(JSON.parse(readFileSync(join(home, '.gemini', 'antigravity', 'mcp_config.json'), 'utf8')).mcpServers.baton.command, L.command);

  assert.deepEqual(setup({ home, launch: L, run, only: ['cursor'] }).map((o) => o.state), ['already']);
  assert.deepEqual(setup({ home, run, remove: true, only: ['cursor'] }).map((o) => o.state), ['removed']);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers, { dart: { command: 'dart' } });
});

test('setup leaves a JSON file with comments alone and says so', () => {
  const home = mkdtempSync(join(tmpdir(), 'baton-setup-'));
  mkdirSync(join(home, '.cursor'));
  const original = '{\n  // mine\n  "mcpServers": {}\n}\n';
  writeFileSync(join(home, '.cursor', 'mcp.json'), original);
  const [o] = setup({ home, launch: L, run: () => '', only: ['cursor'] });
  assert.equal(o!.state, 'skipped');
  assert.equal(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'), original);
});

test('setup installs the Claude Code plugin unless it is already there', () => {
  const home = mkdtempSync(join(tmpdir(), 'baton-setup-'));
  mkdirSync(join(home, '.claude'));
  const calls: string[] = [];
  const fresh = setup({ home, launch: L, only: ['claude'], run: (_c, a) => { calls.push(a.join(' ')); return ''; } });
  assert.equal(fresh[0]!.state, 'added');
  assert.deepEqual(calls, ['plugin list', 'plugin marketplace add kanumuri9593/Baton', 'plugin install baton@baton']);
  const again = setup({ home, launch: L, only: ['claude'], run: () => 'baton@baton  0.2.9  enabled' });
  assert.equal(again[0]!.state, 'already');
});

test('setup rejects a client name it does not know', () => {
  assert.throws(() => setup({ only: ['notepad'] }), /unknown client: notepad/);
});
