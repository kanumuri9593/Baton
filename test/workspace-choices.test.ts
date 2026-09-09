import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'baton-choices-'));
process.env.BATON_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { WorkspaceChoices } = await import('../src/workspace/choices.ts');
const { workspacesStorePath } = await import('../src/core/paths.ts');

test('a provider choice survives a daemon restart and stays scoped to its manifest', () => {
  const choices = new WorkspaceChoices();
  assert.deepEqual(choices.get('/a/baton.workspace.json'), {});

  choices.set('/a/baton.workspace.json', 'postgres', 'staging');
  choices.set('/a/baton.workspace.json', 'api', 'local');
  choices.set('/b/baton.workspace.json', 'postgres', 'docker');

  const reloaded = new WorkspaceChoices();
  assert.deepEqual(reloaded.get('/a/baton.workspace.json'), { postgres: 'staging', api: 'local' });
  assert.deepEqual(reloaded.get('/b/baton.workspace.json'), { postgres: 'docker' });
  assert.deepEqual(reloaded.get('/c/baton.workspace.json'), {});
});

test('the returned choices are a copy, so a caller cannot mutate the store by accident', () => {
  const choices = new WorkspaceChoices();
  choices.set('/a/baton.workspace.json', 'postgres', 'staging');
  const taken = choices.get('/a/baton.workspace.json');
  taken.postgres = 'tampered';
  assert.equal(choices.get('/a/baton.workspace.json').postgres, 'staging');
});

test('a corrupted store is not worth failing a launch over', () => {
  writeFileSync(workspacesStorePath(), '{ this is not json');
  const choices = new WorkspaceChoices();
  assert.deepEqual(choices.get('/a/baton.workspace.json'), {});
  choices.set('/a/baton.workspace.json', 'postgres', 'docker');
  assert.deepEqual(new WorkspaceChoices().get('/a/baton.workspace.json'), { postgres: 'docker' });
});
