import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseManifest } from '../src/workspace/manifest.ts';
import { renderExports, dependencyEnv, toDartDefines } from '../src/workspace/exports.ts';

const base = resolve('/repo');

const manifest = parseManifest({
  name: 'Delivery',
  nodes: {
    db: { providers: { local: { remote: { url: 'postgres://127.0.0.1:5432/app' } } }, exports: { DATABASE_URL: '${url}', DB_KIND: 'postgres' } },
    queue: { providers: { local: { remote: { url: 'http://127.0.0.1:8085' } } }, exports: { QUEUE_URL: '${url}/publish' } },
    api: { dependsOn: ['db', 'queue'], providers: { local: { remote: { url: 'http://127.0.0.1:43121' } } }, exports: { API_URL: '${url}' } },
    web: { dependsOn: ['api'], providers: { local: { remote: { url: 'http://127.0.0.1:3000' } } } },
  },
}, base);

test('exports template the live URL and keep literal values as they are', () => {
  assert.deepEqual(
    renderExports(manifest.nodes.db.exports, { url: 'postgres://127.0.0.1:5432/app', name: 'db' }),
    { DATABASE_URL: 'postgres://127.0.0.1:5432/app', DB_KIND: 'postgres' },
  );
  assert.deepEqual(
    renderExports(manifest.nodes.queue.exports, { url: 'http://127.0.0.1:8085', name: 'queue' }),
    { QUEUE_URL: 'http://127.0.0.1:8085/publish' },
  );
});

test('a key that needs a URL is omitted rather than exported as the literal "${url}"', () => {
  assert.deepEqual(renderExports(manifest.nodes.db.exports, { name: 'db' }), { DB_KIND: 'postgres' });
});

test('a node receives only its direct dependencies, later ones winning a collision', () => {
  const urls = { db: 'postgres://127.0.0.1:5432/app', queue: 'http://127.0.0.1:8085', api: 'http://127.0.0.1:43121' };
  assert.deepEqual(dependencyEnv(manifest, 'api', urls), {
    DATABASE_URL: 'postgres://127.0.0.1:5432/app',
    DB_KIND: 'postgres',
    QUEUE_URL: 'http://127.0.0.1:8085/publish',
  });
  // web depends on api only: the database URL is deliberately not transitive.
  assert.deepEqual(dependencyEnv(manifest, 'web', urls), { API_URL: 'http://127.0.0.1:43121' });
  assert.deepEqual(dependencyEnv(manifest, 'db', urls), {});
});

test('Flutter cannot read env, so exports become dart defines in a stable order', () => {
  assert.deepEqual(toDartDefines({ API_URL: 'http://x', B: 'two' }), ['--dart-define=API_URL=http://x', '--dart-define=B=two']);
  assert.deepEqual(toDartDefines({}), []);
});
