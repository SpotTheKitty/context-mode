import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {httpScope} from '../src/core/store/http-scope.ts';
import {openDb,closeDb,metaSet,metaGet} from '../src/core/store/db.ts';
import {migrateTenantStore} from '../src/core/store/tenant-store.ts';
import {ftsInsert,ftsQuery,deleteChunkRows} from '../src/core/store/fts.ts';
import {listenHttp} from '../src/entries/server-http.ts';
import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

test('tenant and project scope applies to FTS, vocabulary, metadata, mutations and legacy tagging',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-tenants-'));const database=join(dir,'context.db');
 const project={projectKey:'one',projectDir:dir,dbPath:database,worktree:dir,containmentRoot:dir,agent:'codex',source:'spawn-cwd'};
 const scoped=(tenant,fn,p=project)=>httpScope.run({tenant,database},async()=>{const db=await openDb(p);try{return await fn(db)}finally{closeDb(db)}});
 try {
  for(const tenant of ['alpha','beta']) await scoped(tenant,db=>{metaSet(db,'same-key',tenant);ftsInsert(db,{sessionId:'same',worktree:dir,agent:'codex',kind:'content',label:'same',bytes:32,createdAt:Date.now()},[{ord:0,text:tenant+' unique '+tenant+'token',bytes:32}]);});
  for(const tenant of ['alpha','beta']) await scoped(tenant,db=>{
   assert.equal(metaGet(db,'same-key'),tenant);
   assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM chunks WHERE chunks MATCH 'unique'").get().n,1);
   assert.deepEqual(db.raw.prepare('SELECT DISTINCT tenant FROM sources').all().map(r=>r.tenant),[tenant]);
   assert.equal(db.raw.prepare('SELECT term FROM chunks_vocab WHERE term=?').get(tenant==='alpha'?'betatoken':'alphatoken'),undefined);
  });
  await scoped('alpha',db=>{deleteChunkRows(db.raw,'all');db.raw.exec('DELETE FROM sources');metaSet(db,'same-key','changed');});
  await scoped('beta',db=>{assert.equal(db.raw.prepare('SELECT count(*) AS n FROM chunks').get().n,1);assert.equal(metaGet(db,'same-key'),'beta');});
  await scoped('beta',db=>assert.equal(db.raw.prepare('SELECT count(*) AS n FROM sources').get().n,0),{...project,projectKey:'two'});
  const legacyProject={...project,dbPath:join(dir,'legacy.db')};
  const old=await openDb(legacyProject);metaSet(old,'old-key','old-value');ftsInsert(old,{sessionId:'old',worktree:dir,agent:'codex',kind:'content',label:'legacy',bytes:12,createdAt:Date.now()},[{ord:0,text:'legacy text',bytes:12}]);closeDb(old);
  const legacy=new DatabaseSync(legacyProject.dbPath);migrateTenantStore(legacy,'imported','legacy-project');
  for(const table of ['sources','events','meta','chunks','line_units']) assert.ok(legacy.prepare(`PRAGMA table_info(${table})`).all().some(r=>r.name==='tenant'));
  assert.equal(legacy.prepare('SELECT tenant FROM sources').get().tenant,'imported');assert.equal(legacy.prepare('SELECT tenant FROM chunks').get().tenant,'imported');assert.equal(legacy.prepare('SELECT value FROM meta').get().value,'old-value');legacy.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('bundled server runs from a flat directory without a repository or node_modules',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-flat-'));let child;
 try{
  await build({absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),entryPoints:['src/entries/server-http.ts'],outfile:join(dir,'server-http.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',external:['node:*'],banner:{js:'import {createRequire as __cmCreateRequire} from "node:module"; const require=__cmCreateRequire(import.meta.url);'}});
  const table=join(dir,'endpoints.json');writeFileSync(table,JSON.stringify({contextMode:{host:'127.0.0.1',port:0,path:'/mcp',tenantHeader:'x-context-tenant',dataDir:join(dir,'data'),maxRequestBytes:1000000,tenants:{alpha:{agent:'codex'}}}}));
  child=spawn(process.execPath,[join(dir,'server-http.mjs'),table],{cwd:dir,stdio:['ignore','ignore','pipe'],windowsHide:true});
  const ready=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('flat entry did not listen within 30 seconds: '+text)),30000);child.on('exit',code=>{clearTimeout(timer);reject(new Error('entry exited '+code+': '+text))});child.stderr.on('data',data=>{text+=data;for(const line of text.split('\n')){try{const row=JSON.parse(line);if(row.event==='listening'){clearTimeout(timer);resolve(row);return;}}catch{}}});});
  assert.equal(ready.pid,child.pid);assert.equal(ready.parentPid,process.pid);
  const res=await fetch(`http://127.0.0.1:${ready.address.port}/healthz`);assert.equal(res.status,200);
  console.log('flat HTTP server process: node '+ready.pid+'; parent '+ready.parentPid+'; one server for all tenants');
 }finally{if(child){child.kill();await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
});

test('HTTP ctx_index and ctx_search isolate two concurrent tenants in one SQLite file',async()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'cm-http-'));const host=await listenHttp({host:'127.0.0.1',port:0,path:'/mcp',tenantHeader:'x-context-tenant',dataDir,maxRequestBytes:1000000,tenants:{alpha:{agent:'codex'},beta:{agent:'codex'}}});
 const endpoint=`http://127.0.0.1:${host.address().port}/mcp`;
 async function call(tenant,name,args){const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26','x-context-tenant':tenant},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{...args,_workspace:dataDir,_sessionId:'shared-session'}}})});const body=await res.json();assert.equal(res.status,200,JSON.stringify(body));assert.ok(!body.error,JSON.stringify(body));assert.ok(!body.result.isError,JSON.stringify(body));return JSON.stringify(body.result);}
 try {
  assert.equal((await fetch(endpoint,{method:'POST'})).status,403);
  for(const tenant of ['alpha','beta']) await call(tenant,'ctx_index',{content:`${tenant} secretmarker`,source:tenant});
  for(const tenant of ['alpha','beta']) {const result=await call(tenant,'ctx_search',{queries:['secretmarker']});assert.match(result,new RegExp(tenant));assert.doesNotMatch(result,new RegExp(tenant==='alpha'?'beta':'alpha'));}
  const raw=new DatabaseSync(join(dataDir,'context.db'));assert.equal(raw.prepare('SELECT count(DISTINCT tenant) AS n FROM sources').get().n,2);raw.close();
 }finally{await new Promise(r=>host.close(r));rmSync(dataDir,{recursive:true,force:true});}
});
