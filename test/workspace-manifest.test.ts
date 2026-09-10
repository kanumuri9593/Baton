import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after } from 'node:test';
import {
  parseManifest, findManifest, readManifest, chosenProvider, canonical, MANIFEST_FILE,
} from '../src/workspace/manifest.ts';

const base = resolve('/repo');

/** The spec's example, trimmed to what a test needs, as plain JSON. */
function example(): Record<string, unknown> {
  return {
    name: 'Delivery',
    nodes: {
      postgres: {
        kind: 'datastore',
        providers: {
          docker: { compose: { file: './infra/docker-compose.yml', service: 'postgres' }, ready: { tcp: 5432 } },
          staging: { remote: { url: 'postgres://staging-db:5432/app' } },
        },
        exports: { DATABASE_URL: '${url}' },
      },
      api: {
        kind: 'backend',
        dependsOn: ['postgres'],
        providers: {
          local: { target: { cwd: './api', name: 'Delivery API' }, url: 'http://127.0.0.1:43121', ready: { http: 'http://127.0.0.1:43121/health' } },
        },
      },
    },
    defaults: { postgres: 'docker' },
  };
}

test('a manifest parses with display defaults filled in and paths resolved against the file', () => {
  const manifest = parseManifest(example(), base);
  assert.equal(manifest.name, 'Delivery');
  assert.deepEqual(manifest.nodes.postgres.dependsOn, []);
  assert.equal(manifest.nodes.api.kind, 'backend');
  assert.deepEqual(manifest.nodes.api.exports, {});
  assert.equal(manifest.nodes.api.providers.local.timeoutMs, 60000);
  assert.equal(manifest.nodes.api.providers.local.target?.cwd, resolve(base, 'api'));
  assert.equal(manifest.nodes.postgres.providers.docker.compose?.file, resolve(base, 'infra/docker-compose.yml'));
  // A remote URL is an endpoint, not a path: it must survive resolution untouched.
  assert.equal(manifest.nodes.postgres.providers.staging.remote?.url, 'postgres://staging-db:5432/app');
});

test('a provider is exactly one of target, compose or remote', () => {
  const two = example();
  (two.nodes as any).api.providers.local.remote = { url: 'https://api.example.com' };
  assert.throws(() => parseManifest(two, base), /exactly one of target, compose or remote/);

  const none = example();
  delete (none.nodes as any).api.providers.local.target;
  assert.throws(() => parseManifest(none, base), /exactly one of target, compose or remote/);
});

test('unknown keys are refused so a typo is never silently ignored', () => {
  const typo = example();
  (typo.nodes as any).api.dependsUpon = ['postgres'];
  assert.throws(() => parseManifest(typo, base));
});

test('defaults must name a node that exists and a provider that node offers', () => {
  const ghostNode = example();
  (ghostNode as any).defaults = { redis: 'docker' };
  assert.throws(() => parseManifest(ghostNode, base), /redis/);

  const ghostProvider = example();
  (ghostProvider as any).defaults = { postgres: 'kubernetes' };
  assert.throws(() => parseManifest(ghostProvider, base), /kubernetes/);
});

test('readiness accepts the declared shapes and refuses an impossible port', () => {
  for (const ready of ['running', 'url', { tcp: 5432 }, { http: 'http://x/health', status: 204 }, { log: 'ready in' }]) {
    const one = example();
    (one.nodes as any).api.providers.local.ready = ready;
    assert.deepEqual(parseManifest(one, base).nodes.api.providers.local.ready, ready);
  }
  const bad = example();
  (bad.nodes as any).api.providers.local.ready = { tcp: 70000 };
  assert.throws(() => parseManifest(bad, base));
});

test('a workspace is capped at 24 nodes and needs at least one', () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 25; i += 1) many[`n${i}`] = { providers: { local: { remote: { url: 'http://x' } } } };
  assert.throws(() => parseManifest({ name: 'Big', nodes: many }, base));
  assert.throws(() => parseManifest({ name: 'Empty', nodes: {} }, base));
});

test('chosenProvider prefers an override, then this machine, then the team default, then a sole provider', () => {
  const manifest = parseManifest(example(), base);
  assert.equal(chosenProvider(manifest, 'postgres', { postgres: 'staging' }, { postgres: 'docker' }), 'staging');
  assert.equal(chosenProvider(manifest, 'postgres', {}, { postgres: 'staging' }), 'staging');
  assert.equal(chosenProvider(manifest, 'postgres', {}, {}), 'docker');
  // api declares one provider and no default: there is nothing to be ambiguous about.
  assert.equal(chosenProvider(manifest, 'api', {}, {}), 'local');
});

test('an ambiguous node names its choices instead of guessing', () => {
  const noDefault = example();
  delete (noDefault as any).defaults;
  const manifest = parseManifest(noDefault, base);
  assert.throws(() => chosenProvider(manifest, 'postgres', {}, {}), /docker.*staging|staging.*docker/s);
  assert.throws(() => chosenProvider(manifest, 'postgres', { postgres: 'nope' }, {}), /nope/);
});

test('findManifest accepts a file, a directory, or any directory beneath one', () => {
  // Real path: findManifest canonicalises, and on macOS the temp dir is itself
  // reached through a symlink (/var -> /private/var).
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'baton-manifest-')));
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const file = join(scratch, MANIFEST_FILE);
  writeFileSync(file, JSON.stringify(example()));
  mkdirSync(join(scratch, 'api/src'), { recursive: true });

  assert.equal(findManifest(file), file);
  assert.equal(findManifest(scratch), file);
  assert.equal(findManifest(join(scratch, 'api/src')), file);
  assert.equal(findManifest(tmpdir()), undefined);

  const read = readManifest(join(scratch, 'api'));
  assert.equal(read.manifestPath, file);
  assert.equal(read.root, scratch);
  assert.equal(read.manifest.nodes.api.providers.local.target?.cwd, join(scratch, 'api'));
});

test('a manifest reached through a symlink is the same workspace, not a second one', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'baton-symlink-')));
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const real = join(scratch, 'repo');
  mkdirSync(join(real, 'api'), { recursive: true });
  writeFileSync(join(real, MANIFEST_FILE), JSON.stringify(example()));

  const link = join(scratch, 'link-to-repo');
  symlinkSync(real, link, 'dir');

  // Both spellings must name one manifest, or `baton up <path>` and a `switch`
  // run from inside that directory would disagree about which workspace it is.
  assert.equal(findManifest(link), join(real, MANIFEST_FILE));
  assert.equal(findManifest(join(link, 'api')), join(real, MANIFEST_FILE));
  assert.equal(readManifest(link).root, real);
  assert.equal(canonical(link), real);
});

test('canonical falls back to a plain resolve for a path that does not exist yet', () => {
  const missing = join(tmpdir(), 'baton-not-here-' + Math.random().toString(36).slice(2));
  assert.equal(canonical(missing), resolve(missing));
});
