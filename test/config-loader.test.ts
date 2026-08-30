import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfigs, buildFlutterArgv } from '../src/config/loader.ts';

const REAL = 'test/fixtures/mclane360-launch.json';
const JSONC = 'test/fixtures/jsonc-launch.json';

test('loads every configuration from the real McLane360 launch.json', () => {
  const configs = loadConfigs(REAL, '/proj');
  assert.equal(configs.length, 16);
  // the "//" documentation key at the top level must not become a config
  assert.ok(configs.every((c) => c.name && c.name !== '//'));
});

test('classifies dart configs as flutter and runtimeExecutable configs as process', () => {
  const configs = loadConfigs(JSONC, '/proj');
  assert.equal(configs.length, 2);
  assert.equal(configs[0].kind, 'flutter');
  assert.equal(configs[1].kind, 'process');
  assert.deepEqual(configs[1].runtimeArgs, ['serve', 'docs', '-l', '7654']);
});

test('coerces env from launch.json: numbers become strings, null keys are dropped', () => {
  const configs = loadConfigs(JSONC, '/proj');
  assert.deepEqual(configs[0].env, { FOO: 'bar', PORT: '8080' });
  assert.ok(!('NOPE' in (configs[0].env ?? {})), 'a null value must not survive coercion');
});

test('parses JSONC: line comments, block comments, trailing commas', () => {
  // JSON.parse must genuinely fail on this input, or the test proves nothing
  const raw = readFileSync(JSONC, 'utf8');
  assert.throws(() => JSON.parse(raw));
  const configs = loadConfigs(JSONC, '/proj');
  assert.equal(configs[0].name, 'Sim DEV');
});

test('passes toolArgs through verbatim and injects --machine', () => {
  const configs = loadConfigs(REAL, '/proj');
  const dev = configs.find((c) => c.name === 'iOS Simulator (DEV / dev flavor)')!;
  const argv = buildFlutterArgv(dev, 'ABC-123');

  assert.equal(argv[0], 'run');
  assert.ok(argv.includes('--machine'), 'must request the machine protocol');
  assert.deepEqual(argv.slice(argv.indexOf('-t'), argv.indexOf('-t') + 2), ['-t', 'lib/main.dart']);
  assert.deepEqual(argv.slice(argv.indexOf('-d'), argv.indexOf('-d') + 2), ['-d', 'ABC-123']);

  // every toolArg survives, in order
  const flavorAt = argv.indexOf('--flavor');
  assert.equal(argv[flavorAt + 1], 'dev');
  assert.ok(argv.includes('--dart-define-from-file=config/dev.json'));
  assert.ok(argv.includes('--dart-define-from-file=config/secrets.dev.json'));
  assert.ok(argv.includes('--dart-define-from-file=config/secrets.local.json'));
});

test('web configs keep their deviceId, port and browser flags intact', () => {
  const configs = loadConfigs(REAL, '/proj');
  const web = configs.find((c) => c.name === 'Flutter Web (localhost:8888, TST)')!;
  assert.equal(web.deviceId, 'chrome');

  // an explicit deviceId in the config wins over any resolver suggestion
  const argv = buildFlutterArgv(web, 'SOME-SIMULATOR-UDID');
  assert.deepEqual(argv.slice(argv.indexOf('-d'), argv.indexOf('-d') + 2), ['-d', 'chrome']);
  assert.equal(argv.filter((a) => a === '-d').length, 1, 'device must not be passed twice');

  assert.ok(argv.includes('--web-port=8888'));
  assert.ok(argv.includes('--web-hostname=localhost'));
  assert.ok(argv.includes('--web-browser-flag=--disable-web-security'));
  assert.ok(argv.includes('--dart-define=OKTA_WEB_REDIRECT_URI=http://localhost:8888/callback'));
});

test('never passes -d all, which --machine rejects', () => {
  const configs = loadConfigs(REAL, '/proj');
  for (const c of configs.filter((x) => x.kind === 'flutter')) {
    const argv = buildFlutterArgv(c, 'RESOLVED-DEVICE');
    assert.ok(!argv.includes('all'), `${c.name} must not target -d all`);
  }
});
