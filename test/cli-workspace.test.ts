import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseUntil, parseProviders } from '../src/cli/args.ts';

test('--until accepts every readiness condition the manifest can declare', () => {
  assert.equal(parseUntil('running'), 'running');
  assert.equal(parseUntil('stopped'), 'stopped');
  assert.equal(parseUntil('url'), 'url');
  assert.deepEqual(parseUntil('log:ready in'), { log: 'ready in' });
  assert.deepEqual(parseUntil('tcp:5432'), { tcp: 5432 });
  assert.deepEqual(parseUntil('http://127.0.0.1:8080/health'), { http: 'http://127.0.0.1:8080/health' });
  assert.deepEqual(parseUntil('https://api.example.com/health'), { http: 'https://api.example.com/health' });
});

test('an unusable --until says what is allowed rather than waiting for nothing', () => {
  assert.throws(() => parseUntil('bogus'), /running, stopped, url, log:<regex>, tcp:<port> or http:<url>/);
  assert.throws(() => parseUntil('tcp:0'), /between 1 and 65535/);
  assert.throws(() => parseUntil('tcp:not-a-port'), /between 1 and 65535/);
});

test('--provider takes node=provider pairs, and is repeatable', () => {
  assert.deepEqual(parseProviders(['postgres=staging', 'api=dev']), { postgres: 'staging', api: 'dev' });
  assert.deepEqual(parseProviders([]), {});
  // A provider name may itself contain '=' in a URL-ish value; only the first splits.
  assert.deepEqual(parseProviders(['api=a=b']), { api: 'a=b' });
  assert.throws(() => parseProviders(['postgres']), /node=provider/);
  assert.throws(() => parseProviders(['=staging']), /node=provider/);
});

test('help documents every workspace command, and the collisions it resolves', () => {
  const help = execFileSync(process.execPath, [resolve('src/cli/index.ts'), 'help'], { encoding: 'utf8' });
  for (const line of ['baton up ', 'baton down ', 'baton switch <node> <provider>', 'baton restart <node> [--cascade]']) {
    assert.ok(help.includes(line), `help must document "${line}"`);
  }
  // `status` and `restart` mean two things now; help has to say which is which.
  assert.match(help, /baton status \[session\|dir\]/);
  assert.match(help, /a workspace node here, else a session/);
  assert.match(help, /tcp:<port>\|http:<url>/);
});

test('the MCP surface names the five workspace tools and marks run_workflow legacy', () => {
  const source = readFileSync(resolve('src/mcp/index.ts'), 'utf8');
  for (const tool of ['start_workspace', 'stop_workspace', 'workspace_status', 'switch_provider', 'restart_node']) {
    assert.match(source, new RegExp(`'${tool}'`), `MCP must expose ${tool}`);
  }
  assert.match(source, /Legacy flat form/, 'run_workflow must point agents at start_workspace');
  // An agent that polls is the thing these tools exist to prevent.
  assert.match(source, /Blocks until every node has settled, so do not poll/);
  assert.match(source, /never stopped/, 'ownership has to be stated where an agent will read it');
});

test('help says status and restart each cover two things, and never implies a guess', () => {
  const help = execFileSync(process.execPath, [resolve('src/cli/index.ts'), 'help'], { encoding: 'utf8' });
  assert.match(help, /a workspace here: node · provider · status · url/);
  assert.match(help, /a named session: status, uptime/);
});

test('the CLI never falls back to an unrelated workspace when a path was named', () => {
  const source = readFileSync(resolve('src/cli/index.ts'), 'utf8');
  // Guarding the fallback on `session` is the whole fix: without it, asking
  // about one directory can print a workspace rooted somewhere else entirely.
  assert.match(source, /mine\.length \|\| session \? mine : workspaces/);
  assert.match(source, /no workspace is up for/);
});

test('an ambiguous workspace is refused by naming both, rather than picking one', () => {
  const source = readFileSync(resolve('src/cli/index.ts'), 'utf8');
  assert.match(source, /workspaces are up here/);
  assert.match(source, /Name the one you mean by its id/);
});
