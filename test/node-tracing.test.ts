import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStream, TRACE_PREFIX } from '../src/instrumentation/stream.ts';
const state = mkdtempSync(join(tmpdir(),'baton-trace-test-'));
process.env.BATON_HOME = state;
const { LaunchDaemon } = await import('../src/daemon/server.ts');

test('trace decoder handles fragmented stdout and keeps metadata out of application logs', () => {
  const logs: string[]=[]; let ready=0;
  const stream=new TraceStream({log:t=>logs.push(t),ready:()=>ready++,row:()=>{}});
  stream.write('hello\n'+TRACE_PREFIX+'{"rea'); stream.write('dy":true}\n');
  stream.write(TRACE_PREFIX+'bad json\nlast');stream.flush();
  assert.equal(ready,1);assert.deepEqual(logs,['hello\n','last\n']);
});

test('OpenTelemetry correlates fetch and HTTP across two sessions without capturing query secrets', async (t) => {
  const daemon = new LaunchDaemon(); await daemon.listen();
  t.after(async()=>{await daemon.close();rmSync(state,{recursive:true,force:true});});
  async function run(name: string, response: string) {
    const cwd=join(state,name);mkdirSync(join(cwd,'.vscode'),{recursive:true});
    const code=`import {createServer} from 'node:http'; createServer(async(q,s)=>{${response}}).listen(0,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port)})`;
    writeFileSync(join(cwd,'server.mjs'),code);
    writeFileSync(join(cwd,'.vscode/launch.json'),JSON.stringify({configurations:[{name,runtimeExecutable:process.execPath,runtimeArgs:['server.mjs'],batonKind:'web-dev',batonTrace:true}]}));
    const session:any=await daemon.handle({method:'run',params:{cwd,target:name}});
    const ready:any=await daemon.handle({method:'wait',params:{session:session.id,until:'url',timeoutMs:10000}});
    return {id:session.id,url:ready.url};
  }
  const api=await run('api',"s.statusCode=503;s.end('offline');");
  const web=await run('web',`const r=await fetch('${api.url}/delivery?token=private-query');s.statusCode=r.status;s.end(await r.text());`);
  assert.equal((await fetch(web.url+'/api/delivery')).status,503);
  let a:any[]=[], b:any[]=[];
  for(let i=0;i<60;i++){
    a=await daemon.handle({method:'network',params:{session:api.id}}) as any[];
    b=await daemon.handle({method:'network',params:{session:web.id}}) as any[];
    if(a.length && b.length>=2)break;
    await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(a.length, 'inbound API request captured');
  assert.ok(b.some(r=>r.direction==='outbound'),'native fetch captured');
  assert.ok(b.some(r=>r.traceId===a[0].traceId),'trace context propagated across projects');
  assert.ok(!JSON.stringify([...a,...b]).includes('private-query'));
  const findings:any=await daemon.handle({method:'diagnose',params:{query:a[0].traceId,errorsOnly:false}});
  assert.equal(new Set(findings.findings.map((f:any)=>f.session)).size,2);
  const detail:any=await daemon.handle({method:'networkDetail',params:{session:api.id,id:a[0].id}});
  assert.deepEqual(detail.requestHeaders,{});
});
