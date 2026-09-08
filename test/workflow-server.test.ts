import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const state = mkdtempSync(join(tmpdir(),'baton-workflow-server-'));
process.env.BATON_HOME = state;
const { LaunchDaemon } = await import('../src/daemon/server.ts');

test('real workflow launches two project servers with explicit web adapters and returns reachable URLs', async (t) => {
  const daemon = new LaunchDaemon();
  await daemon.listen();
  t.after(async () => { await daemon.close(); rmSync(state,{recursive:true,force:true}); });
  const steps = ['api','console'].map(name => {
    const root = join(state,name);
    mkdirSync(join(root,'.vscode'),{recursive:true});
    const code = `require('node:http').createServer((q,s)=>s.end('${name}')).listen(0,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port)})`;
    writeFileSync(join(root,'.vscode/launch.json'), JSON.stringify({configurations:[{name,type:'node',batonKind:'web-dev',runtimeExecutable:process.execPath,runtimeArgs:['-e',code]}]}));
    return {name,cwd:root,target:name,until:'url',timeoutMs:5000};
  });
  const result: any = await daemon.handle({method:'workflowRun',params:{name:'Two servers',steps}});
  assert.equal(result.ok,true);
  for (const step of result.steps) {
    assert.equal(await (await fetch(step.url)).text(),step.name);
    assert.equal(daemon.registry.get(step.session)?.status,'running');
  }
});
