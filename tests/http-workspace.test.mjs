import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listenHttp} from '../src/entries/server-http.ts';
import {injectWorkspace} from '../src/entries/hook-http.ts';

test('HTTP workspace fallback works for all tenants and explicit workspace wins',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-workspace-'));
 const shared=join(root,'shared'), own=join(root,'own');mkdirSync(shared);mkdirSync(own);
 const config={host:'127.0.0.1',port:0,path:'/mcp',tenantHeader:'x-context-tenant',dataDir:join(root,'data'),maxRequestBytes:1000000,defaultWorkspace:shared,tenants:{claude:{agent:'claude-code'},codex:{agent:'codex',defaultWorkspace:own}}};
 const server=await listenHttp(config);
 try{
  const call=async(tenant,args={},meta)=>{
   const res=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json,text/event-stream','x-context-tenant':tenant},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ctx_stats',arguments:args,_meta:meta}})});
   assert.equal(res.status,200);const body=await res.json();assert.equal(body.error,undefined);assert.notEqual(body.result.isError,true,JSON.stringify(body));return body.result.content[0].text;
  };
  assert.match(await call('claude'),new RegExp('Workspace fallback: '+shared.replaceAll('\\','\\\\')));
  assert.match(await call('codex'),/Workspace fallback:/);
  assert.doesNotMatch(await call('claude',{_workspace:own}),/Workspace fallback:/);
  assert.doesNotMatch(await call('claude',{}, {cwd:own}),/Workspace fallback:/);
  delete config.defaultWorkspace;config.sessionRoot=shared;
  assert.match(await call('claude'),/Workspace fallback:/);
 }finally{await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});

test('Claude native updatedInput preserves input, explicit workspace and denies',()=>{
 const raw={hook_event_name:'PreToolUse',cwd:'F:/projects-test/work',tool_name:'mcp__contextMode__ctx_execute',tool_input:{language:'javascript',code:'console.log(1)'}};
 const allow={stdout:'',exitCode:0};
 assert.deepEqual(JSON.parse(injectWorkspace(allow,raw,'claude-code').stdout).hookSpecificOutput.updatedInput,{...raw.tool_input,_workspace:raw.cwd});
 assert.equal(injectWorkspace(allow,{...raw,tool_input:{_workspace:'explicit'}},'claude-code'),allow);
 const deny={stdout:JSON.stringify({hookSpecificOutput:{permissionDecision:'deny'}}),exitCode:0};
 assert.equal(injectWorkspace(deny,raw,'claude-code'),deny);
 assert.equal(injectWorkspace(allow,{...raw,tool_name:'other'},'claude-code'),allow);
});
