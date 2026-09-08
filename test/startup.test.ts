import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state=mkdtempSync(join(tmpdir(),'baton-startup-test-'));
process.env.BATON_HOME=state;
const { LaunchDaemon, readHandshake }=await import('../src/daemon/server.ts');
const { startDaemon }=await import('../src/core/client.ts');

test('start reuses a live daemon and closing an old daemon preserves the new handshake',async()=>{
  const old=new LaunchDaemon(),current=new LaunchDaemon();
  try {
    await old.listen();const expected=await current.listen();
    assert.deepEqual(readdirSync(state).filter((name) => name.includes('.tmp-')), [],
      'handshake publication must not leave temporary files behind');
    assert.equal((await startDaemon()).port,expected.port);
    await old.close();assert.equal(readHandshake()?.port,expected.port);
  } finally {await current.close();rmSync(state,{recursive:true,force:true});}
});
