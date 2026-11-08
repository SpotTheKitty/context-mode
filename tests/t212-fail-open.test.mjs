import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {forwardHook} from '../src/entries/hook-http.ts';
import {importDatabase,legacyWorkspace,legacyProjectKey} from '../src/entries/import.ts';
import {resolveProject} from '../src/core/project/resolve.ts';
test('HTTP timeout allows shell and logs exactly one line',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'http-timeout-'));const host=createServer(()=>{});
 await new Promise(r=>host.listen(0,'127.0.0.1',r));
 try{
  const out=await forwardHook({dataDir:dir,host:'127.0.0.1',port:host.address().port,path:'/mcp',tenantHeader:'x-context-tenant',hookTimeoutMs:25,tenants:{alpha:{agent:'claude-code'}}},'alpha',{hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'pwsh'}});
  assert.equal(out.stdout,'');assert.equal(out.exitCode,0);assert.match(out.stderr,/allowed/);
  assert.equal(readFileSync(join(dir,'hook-errors.log'),'utf8').trim().split('\n').length,1);
 }finally{host.closeAllConnections();await new Promise(r=>host.close(r));rmSync(dir,{recursive:true,force:true});}
});
for(const scenario of ['vanished workspace resolves by rule','session without workspace uses tenant legacy key','explicit mapping wins','session resume supplies workspace']){
 test(scenario,()=>{
  const dir=mkdtempSync(join(tmpdir(),'import-fallback-'));
  try{
   const dbPath=join(dir,'session.db');const db=new DatabaseSync(dbPath);
   db.exec('CREATE TABLE session_events(id INTEGER,session_id TEXT,data TEXT,project_dir TEXT); CREATE TABLE session_resume(session_id TEXT,worktree TEXT)');
   const workspace=scenario.startsWith('session')?'':join(dir,'vanished','child');
   db.prepare('INSERT INTO session_events VALUES(1,?,?,?)').run('s','hello',workspace);
   if(scenario.includes('resume')) db.prepare('INSERT INTO session_resume VALUES(?,?)').run('s',dir);
   db.close();
   const config={dataDir:join(dir,'out'),tenants:{alpha:{}},imports:[],importProjectMappings:scenario.startsWith('explicit')?{[workspace]:tmpdir()}:{}};
   const result=importDatabase(dbPath,{tenant:'alpha',root:dir},config,true);
   const expected=scenario.includes('without')?legacyProjectKey('alpha'):resolveProject('codex',{env:{},argv:[],cwd:scenario.startsWith('explicit')?tmpdir():dir}).projectKey;
   assert.deepEqual(result.projects,[expected]);assert.equal(importDatabase(dbPath,{tenant:'alpha',root:dir},config,true).alreadyImported,true);
   assert.equal(legacyWorkspace(join(dir,'gone')),dir);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
}

test('UNC and slash-drive spellings fold to the same ancestor',{skip:process.platform!=='win32'},()=>{
 assert.equal(legacyWorkspace('//host/c$/Users/spott/missing-t212'),legacyWorkspace('C:/Users/spott/missing-t212'));
 assert.equal(legacyWorkspace('/c/Users/spott/missing-t212'),legacyWorkspace('C:/Users/spott/missing-t212'));
});
test('HTTP non-success allows and logs one line',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'http-status-'));const host=createServer((_,res)=>{res.writeHead(503);res.end();});
 await new Promise(r=>host.listen(0,'127.0.0.1',r));
 try{
  const out=await forwardHook({dataDir:dir,host:'127.0.0.1',port:host.address().port,path:'/mcp',tenantHeader:'x-context-tenant',hookTimeoutMs:2000,tenants:{alpha:{agent:'claude-code'}}},'alpha',{hook_event_name:'PostToolUse'});
  assert.equal(out.stdout,'');assert.equal(out.exitCode,0);
  assert.equal(readFileSync(join(dir,'hook-errors.log'),'utf8').trim().split('\n').length,1);
 }finally{host.closeAllConnections();await new Promise(r=>host.close(r));rmSync(dir,{recursive:true,force:true});}
});
