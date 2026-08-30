import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigs } from '../src/config/loader.ts';
import { validate, isRunnable } from '../src/config/validate.ts';

const REAL = 'test/fixtures/mclane360-launch.json';
const PROJECT = '/Users/yxkanum/Documents/McLane360';

test('a config whose dart-define files all exist is runnable', () => {
  const configs = loadConfigs(REAL, PROJECT);
  const dev = configs.find((c) => c.name === 'iOS Simulator (DEV / dev flavor)')!;
  assert.deepEqual(validate(dev), []);
  assert.equal(isRunnable(dev), true);
});

test('names the missing file and how to create it', () => {
  const configs = loadConfigs(REAL, '/nonexistent-project-root');
  const dev = configs.find((c) => c.name === 'iOS Simulator (DEV / dev flavor)')!;
  const issues = validate(dev);

  assert.ok(issues.length > 0);
  assert.ok(issues.some((i) => i.path === 'config/dev.json'));
  for (const issue of issues) assert.match(issue.hint, /create|copy/);
});

test('suggests the template file when one exists beside the missing file', () => {
  // secrets.local.json is gitignored but ships a secrets.local.template.json
  const configs = loadConfigs(REAL, PROJECT);
  const config = {
    ...configs[0],
    toolArgs: ['--dart-define-from-file=config/secrets.absent.json'],
  };
  const [issue] = validate(config);
  assert.equal(issue.path, 'config/secrets.absent.json');
});

test('ignores non-file tool arguments', () => {
  const config = {
    name: 'x', kind: 'flutter' as const, cwd: PROJECT,
    toolArgs: ['--flavor', 'dev', '--dart-define=VERBOSE_LOGS=true'], args: [],
  };
  assert.deepEqual(validate(config), []);
});
