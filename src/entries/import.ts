// Offline, one-time import. Sources are read-only snapshots; no file synchronization.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateTenantStore } from '../core/store/tenant-store.ts';
import { resolveProject } from '../core/project/resolve.ts';
import { DB_FILE_NAME } from '../core/contracts/constants.ts';

type Row = Record<string, string | number | null>;
export interface ImportSource { tenant: string; root: string; workspace?: string; projectKey?: string }
interface ImportConfig { dataDir: string; tenants: Record<string, unknown>; imports: (Omit<ImportSource,'tenant'> & {tenant?:string})[]; importProjectMappings?: Record<string,string>; importDatabaseMappings?: Record<string,Partial<ImportSource>> }
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const safeJson = (row: Row): string => JSON.stringify(row);
const text = (v: unknown): string => v === null || v === undefined ? '' : String(v);

/** Fold historical Windows spellings, then use the nearest directory still on disk. */
export function legacyWorkspace(workspace: string): string {
  let path=workspace.replaceAll('\\','/').replace(/^\/\/[^/]+\/([a-z])\$?(?:\/|$)/i,(_,drive:string)=>drive+':/').replace(/^\/([a-z])(?:\/|$)/i,(_,drive:string)=>drive+':/');
  const worktree=/^C:\/Users\/[^/]+\/\.t3\/worktrees\/([^/]+)(?:\/|$)/i.exec(path);
  if(worktree && existsSync('F:/Projects/'+worktree[1])) path='F:/Projects/'+worktree[1];
  path=resolve(path);
  while((!existsSync(path) || !statSync(path).isDirectory()) && dirname(path)!==path) path=dirname(path);
  return realpathSync.native(path);
}
export const legacyProjectKey=(tenant:string):string=>hash(tenant+':legacy').slice(0,16);

/** Only explicit configured roots are walked, without following links or opening other file types. */
export function discoverDatabases(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root,{withFileTypes:true})) {
    const path=join(root,entry.name);
    if (entry.isDirectory()) files.push(...discoverDatabases(path));
    else if (entry.isFile() && /\.(?:db|sqlite|sqlite3)$/i.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/** A transaction per source: archive every original row, remap IDs, and rebuild searchable FTS. */
export function importDatabase(sourcePath: string, source: ImportSource, config: ImportConfig, apply=false): Record<string,unknown> {
  if (!Object.hasOwn(config.tenants,source.tenant)) throw new Error('Unknown import tenant: '+source.tenant);
  const canonical=realpathSync.native(sourcePath);
  const destination=resolve(config.dataDir,DB_FILE_NAME);
  if (resolve(canonical).toLowerCase()===destination.toLowerCase()) throw new Error('Cannot import the destination into itself');
  const input=new DatabaseSync(canonical,{readOnly:true});
  let output: DatabaseSync | undefined;
  try {
    input.exec('BEGIN'); // One consistent source snapshot, including its WAL.
    const tables=new Set((input.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
    const modern=tables.has('events') && tables.has('sources');
    const legacy=tables.has('session_events') || (tables.has('sources') && tables.has('chunks'));
    if (!modern && !legacy) throw new Error('Unsupported context-mode schema: '+canonical);
    const names=modern?['events','sources','chunks','line_units','meta']:['session_events','session_meta','session_resume','tool_calls','sources','chunks','vocabulary'];
    const rows=new Map<string,Row[]>();
    for(const name of names) if(tables.has(name)) rows.set(name,input.prepare(`SELECT rowid AS _import_rowid,* FROM ${name}`).all() as Row[]);
    const sessions=new Map<string,string>();
    for(const name of ['session_meta','session_resume','sources']) for(const row of rows.get(name)??[]) {
      const workspace=text(row.worktree || row.project_dir);
      if(workspace) sessions.set(text(row.session_id),workspace);
    }
    const databaseWorkspaces=new Set(sessions.values());
    const projects=new Map<Row,string>();
    for(const records of rows.values()) for(const row of records) {
      let key=source.projectKey;
      const workspace=source.workspace || text(row.worktree || row.project_dir) || sessions.get(text(row.session_id)) || (databaseWorkspaces.size===1?[...databaseWorkspaces][0]:undefined);
      if(!key && workspace) {
        const mapped=config.importProjectMappings?.[workspace] ?? workspace;
        try {key=resolveProject('codex',{env:{},argv:[],cwd:legacyWorkspace(mapped)}).projectKey;}
        catch {key=legacyProjectKey(source.tenant);}
      }
      if(!key && modern && /^[a-f0-9]{16}$/.test(dirname(canonical).split(/[\\/]/).at(-1)??'')) key=dirname(canonical).split(/[\\/]/).at(-1);
      // Meta and legacy content tables have no workspace; a single unambiguous source identity is required.
      if(key) projects.set(row,key);
    }
    const known=new Set(projects.values());
    for(const records of rows.values()) for(const row of records) if(!projects.has(row)) {
      projects.set(row,known.size===1?[...known][0] as string:legacyProjectKey(source.tenant));
    }
    for(const key of projects.values()) known.add(key);
    const digest=hash(JSON.stringify([...rows]));
    const marker='import:'+hash(canonical.toLowerCase());
    const count=[...rows.values()].reduce((n,r)=>n+r.length,0);
    const plan={source:canonical,tenant:source.tenant,destination,rows:count,projects:[...known],applied:false,alreadyImported:false};
    if(!apply || count===0) return plan;
    mkdirSync(dirname(destination),{recursive:true});
    output=new DatabaseSync(destination,{timeout:5000});
    migrateTenantStore(output,source.tenant,[...known][0] as string);
    output.exec('BEGIN IMMEDIATE');
    const old=output.prepare("SELECT value FROM meta WHERE tenant=? AND key=?").get(source.tenant,marker) as {value:string}|undefined;
    if(old) {
      if(old.value!==digest) throw new Error('Previously imported source changed; one-time import refuses synchronization: '+canonical);
      output.exec('ROLLBACK');return {...plan,alreadyImported:true};
    }
    const archive=output.prepare('INSERT INTO legacy_records(tenant,project_key,origin,table_name,record_key,payload) VALUES(?,?,?,?,?,?)');
    for(const [name,records] of rows) for(const row of records) archive.run(source.tenant,projects.get(row)!,canonical,name,text(row._import_rowid),safeJson(row));
    const insert=(table:string,row:Row): number=>{
      const cols=Object.keys(row);
      return Number(output!.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>row[k]!)).lastInsertRowid);
    };
    const sourceIds=new Map<string,number>();
    for(const row of rows.get('sources')??[]) {
      const key=projects.get(row)!;const now=Date.now();
      const record:Row=modern?Object.fromEntries(Object.entries(row).filter(([k])=>!['_import_rowid','id','tenant','project_key'].includes(k))):{
        session_id:'legacy-import',worktree:source.workspace??'',agent:'legacy-import',kind:'content',label:text(row.label),bytes_total:0,chunk_count:Number(row.chunk_count??0),created_ts:now,created_at:new Date(now).toISOString(),accessed_ts:now,
      };
      sourceIds.set(text(row.id),insert('sources',{...record,tenant:source.tenant,project_key:key}));
    }
    const addChunk=(record:Row):void=>{
      const rowid=insert('chunks',record);
      insert('chunks_tri',{rowid,body:record.body!,title:record.title??'',tenant:source.tenant,project_key:record.project_key!});
    };
    for(const row of rows.get('chunks')??[]) {
      const id=sourceIds.get(text(row.source_id));
      if(id===undefined) throw new Error('Orphan chunk in source '+canonical);
      addChunk({source_id:id,session_id:text(row.session_id)||'legacy-import',worktree:text(row.worktree)||source.workspace||'',agent:text(row.agent)||'legacy-import',ord:Number(row.ord??row._import_rowid),body:text(row.body??row.content),title:text(row.title),tenant:source.tenant,project_key:projects.get(row)!});
    }
    for(const row of rows.get('line_units')??[]) {
      const id=sourceIds.get(text(row.source_id));if(id===undefined)throw new Error('Orphan line unit in source '+canonical);
      insert('line_units',{body:row.body!,source_id:id,session_id:row.session_id!,ord:row.ord!,tenant:source.tenant,project_key:projects.get(row)!});
    }
    for(const row of rows.get(modern?'events':'session_events')??[]) {
      const now=Number(row.created_at)||Date.now();const key=projects.get(row)!;
      const record:Row=modern?Object.fromEntries(Object.entries(row).filter(([k])=>!['_import_rowid','seq','tenant','project_key'].includes(k))):{
        session_id:text(row.session_id),worktree:text(row.project_dir)||source.workspace||'',agent:'legacy-import',kind:'decision',body:text(row.data),turn:Number(row.id),created_at:now,accessed_at:now,
      };
      insert('events',{...record,tenant:source.tenant,project_key:key});
      if(!modern) {
        const body=text(row.data);const label='legacy '+text(row.type)+' '+text(row.id);
        const id=insert('sources',{session_id:text(row.session_id),worktree:record.worktree!,agent:'legacy-import',kind:'content',label,bytes_total:Buffer.byteLength(body),chunk_count:1,created_ts:now,created_at:new Date(now).toISOString(),accessed_ts:now,tenant:source.tenant,project_key:key});
        addChunk({source_id:id,session_id:text(row.session_id),worktree:record.worktree!,agent:'legacy-import',ord:0,body,title:label,tenant:source.tenant,project_key:key});
      }
    }
    // Original meta is archived; do not overwrite current server policy or counters.
    for(const key of known) output.prepare('INSERT INTO meta(tenant,project_key,key,value) VALUES(?,?,?,?)').run(source.tenant,key,marker,digest);
    output.exec('COMMIT');return {...plan,applied:true};
  } finally {
    if(output?.isTransaction) output.exec('ROLLBACK');output?.close();
    if(input.isTransaction) input.exec('ROLLBACK');input.close();
  }
}

export function runImport(tablePath:string,apply=false): Record<string,unknown>[] {
  const config=(JSON.parse(readFileSync(tablePath,'utf8').replace(/^\uFEFF/,'')) as {contextMode:ImportConfig}).contextMode;
  const discovered=config.imports.flatMap(root=>discoverDatabases(root.root).map(file=>({root,file})));
  const workspaces=new Map<string,Set<string>>();
  for(const {root,file} of discovered) {
    if(!root.tenant)continue;
    const db=new DatabaseSync(file,{readOnly:true});
    try {
      if(!db.prepare("SELECT name FROM sqlite_master WHERE name='session_meta'").get())continue;
      for(const row of db.prepare('SELECT DISTINCT project_dir FROM session_meta').all() as {project_dir:string}[]) {
        if(!row.project_dir)continue;
        const normalized=row.project_dir.replaceAll('\\','/').replace(/(?<!:)\/+$/,'');
        for(const spelling of [normalized,normalized.toLowerCase()]) {
          const key=root.tenant+':'+hash(spelling).slice(0,16);
          const values=workspaces.get(key)??new Set<string>();values.add(row.project_dir);workspaces.set(key,values);
        }
      }
    } finally {db.close();}
  }
  const files=discovered.map(({root,file})=>{
    const canonical=realpathSync.native(file).replaceAll('\\','/');
    const override=config.importDatabaseMappings?.[canonical];
    const source={...root,...override};
    if(!source.tenant) throw new Error('Shared database requires explicit tenant/workspace ownership in importDatabaseMappings: '+canonical);
    if(!source.workspace && !source.projectKey) {
      const candidates=workspaces.get(source.tenant+':'+basename(file,'.db'));
      if(candidates?.size===1)source.workspace=[...candidates][0];
    }
    return {file,source:source as ImportSource};
  });
  // Preflight every source before creating a destination, including ownership and project mappings.
  const plans=files.map(({file,source})=>importDatabase(file,source,config));
  return apply?files.map(({file,source})=>importDatabase(file,source,config,true)):plans;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const table=process.argv[2];if(!table)throw new Error('Usage: import.mjs <endpoint-table> [--apply]');
  console.log(JSON.stringify(runImport(table,process.argv.includes('--apply'))));
}
