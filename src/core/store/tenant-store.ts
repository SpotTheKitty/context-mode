// HTTP-only connection boundary. Stdio databases and their schema are unchanged.
import type { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { DbHandle, ProjectContext } from "../contracts/types.ts";
import { applyMigrations } from "./schema.ts";
import { httpScope } from "./http-scope.ts";

const TABLES = ["events", "sources", "meta", "chunks", "chunks_tri", "line_units"] as const;
const FTS = new Set(["chunks", "chunks_tri", "line_units"]);
const quote = (s: string): string => "'" + s.replaceAll("'", "''") + "'";

/** Upgrade a v6 database once, tagging every existing row with caller-supplied identity.
 * Run only on a staged database or on the HTTP store, never on a legacy stdio file in place. */
export function migrateTenantStore(raw: DatabaseSync, tenant: string, project: string): void {
  const version = Number((raw.prepare("PRAGMA user_version").get() as {user_version:number}).user_version);
  applyMigrations(raw, version);
  if ((raw.prepare("PRAGMA table_info(sources)").all() as {name:string}[]).some(c => c.name === "tenant")) return;
  raw.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["events", "sources"]) {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN tenant TEXT NOT NULL DEFAULT ''; ALTER TABLE ${table} ADD COLUMN project_key TEXT NOT NULL DEFAULT ''`);
      raw.prepare(`UPDATE ${table} SET tenant=?, project_key=?`).run(tenant, project);
    }
    raw.exec("ALTER TABLE meta RENAME TO meta_legacy; CREATE TABLE meta (tenant TEXT NOT NULL, project_key TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(tenant,project_key,key))");
    raw.prepare("INSERT INTO meta SELECT ?,?,key,value FROM meta_legacy").run(tenant,project);
    raw.exec("DROP TABLE meta_legacy; DROP INDEX idx_events_cost_session_turn; CREATE UNIQUE INDEX idx_events_cost_session_turn ON events(tenant,project_key,session_id,turn) WHERE kind='cost'");
    // FTS5 cannot ALTER columns. Preserve rowids because sources and trigram use them.
    for (const [table, columns, tokenizer] of [
      ["chunks", "source_id UNINDEXED,session_id UNINDEXED,worktree UNINDEXED,agent UNINDEXED,ord UNINDEXED,body,title", "porter unicode61 remove_diacritics 2"],
      ["line_units", "body,source_id UNINDEXED,session_id UNINDEXED,ord UNINDEXED", "porter unicode61 remove_diacritics 2"],
    ]) {
      const names = String(columns).split(",").map(x=>x.split(" ")[0]).join(",");
      raw.exec(`CREATE VIRTUAL TABLE ${table}_tenant USING fts5(${columns},tenant UNINDEXED,project_key UNINDEXED,tokenize='${tokenizer}')`);
      raw.prepare(`INSERT INTO ${table}_tenant(rowid,${names},tenant,project_key) SELECT rowid,${names},?,? FROM ${table}`).run(tenant,project);
      raw.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_tenant RENAME TO ${table}`);
    }
    raw.exec("DROP TABLE chunks_tri; DROP TABLE chunks_vocab; CREATE VIRTUAL TABLE chunks_tri USING fts5(body,title,tenant UNINDEXED,project_key UNINDEXED,tokenize='trigram',content=''); INSERT INTO chunks_tri(rowid,body,title,tenant,project_key) SELECT rowid,body,title,tenant,project_key FROM chunks; CREATE VIRTUAL TABLE chunks_vocab USING fts5vocab(chunks,'row'); CREATE VIRTUAL TABLE chunks_vocab_instances USING fts5vocab(chunks,'instance')");
    raw.exec("CREATE INDEX idx_sources_tenant_project ON sources(tenant,project_key); CREATE INDEX idx_events_tenant_project ON events(tenant,project_key)");
    raw.exec("COMMIT");
  } catch (e) { if (raw.isTransaction) raw.exec("ROLLBACK"); throw e; }
}

/** Trusted plugin SQL only. Unknown write shapes fail closed instead of reaching the shared store. */
export function scopedWrite(sql: string, tenant: string, project: string): string {
  const scope = `tenant=${quote(tenant)} AND project_key=${quote(project)}`;
  const target = /^(\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+)(\w+)/i.exec(sql);
  if (!target) {
    if (/^\s*(?:SELECT|WITH|BEGIN|COMMIT|ROLLBACK|PRAGMA wal_checkpoint)/i.test(sql)) return sql;
    throw new Error("HTTP store refuses unscoped SQL");
  }
  const table = target[2] as string;
  if (!(TABLES as readonly string[]).includes(table)) throw new Error("HTTP store refuses unknown table " + table);
  if (/^\s*INSERT/i.test(sql)) {
    if (/['"]delete-all['"]/.test(sql)) {
      if (table !== "chunks_tri") throw new Error("unsupported FTS maintenance");
      return `INSERT INTO main.chunks_tri(chunks_tri,rowid,body,title,tenant,project_key) SELECT 'delete',rowid,body,title,tenant,project_key FROM chunks`;
    }
    let result = sql.replace(target[0], target[1] + "main." + table);
    const cols = /^(\s*INSERT(?: OR \w+)? INTO main\.\w+\s*\()([^)]*)(\))/i;
    if (!cols.test(result)) throw new Error("HTTP insert requires explicit columns");
    result = result.replace(cols, "$1$2,tenant,project_key$3");
    const values = /\bVALUES\s*\(([^)]*)\)/i;
    if (values.test(result)) result = result.replace(values, `VALUES ($1,${quote(tenant)},${quote(project)})`);
    else if (/\bSELECT\b/i.test(result)) result = result.replace(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i, `SELECT $1,${quote(tenant)},${quote(project)} FROM`);
    else throw new Error("unsupported HTTP insert shape");
    return result.replace(/ON CONFLICT\(key\)/i, "ON CONFLICT(tenant,project_key,key)");
  }
  const result = sql.replace(target[0], target[1] + "main." + table);
  const parts = result.split(/\s+RETURNING\s+/i);
  const body = parts[0] as string;
  const where = /\s+WHERE\s+/i.exec(body);
  const scoped = where ? body.slice(0,where.index) + " WHERE (" + body.slice(where.index+where[0].length) + ") AND " + scope : body + " WHERE " + scope;
  return scoped + (parts.length > 1 ? " RETURNING " + parts[1] : "");
}

export function openTenantDb(project: ProjectContext, readOnly = false): DbHandle {
  const scope = httpScope.getStore();
  if (!scope) throw new Error("missing HTTP tenant scope");
  const {mkdirSync} = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  mkdirSync(dirname(scope.database), {recursive:true});
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const raw = new sqlite.DatabaseSync(scope.database, {timeout:5000});
  scope.closers ??= new Set();
  scope.closers.add(() => raw.close());
  try {
    migrateTenantStore(raw, scope.tenant, project.projectKey);
    const filter = `tenant=${quote(scope.tenant)} AND project_key=${quote(project.projectKey)}`;
    for (const table of TABLES) {
      // A contentless trigram index cannot return its UNINDEXED tenant column. Its rowid is
      // the chunks rowid, so enforce identity through the filtered content table instead.
      const where = table === "chunks_tri" ? "rowid IN (SELECT rowid FROM chunks)" : filter;
      const hidden = FTS.has(table) ? `rowid,${table},` : "";
      raw.exec(`CREATE TEMP VIEW ${table} AS SELECT ${hidden}* FROM main.${table} WHERE ${where}`);
    }
    raw.exec(`CREATE TEMP VIEW chunks_vocab AS SELECT v.term,COUNT(DISTINCT v.doc) AS doc,COUNT(*) AS cnt FROM main.chunks_vocab_instances v JOIN chunks c ON c.rowid=v.doc GROUP BY v.term`);
    if (readOnly) raw.exec("PRAGMA query_only=ON");
    const handle = new Proxy(raw, { get(target, key) {
      if (key === "prepare") return (sql: string) => target.prepare(scopedWrite(sql,scope.tenant,project.projectKey));
      if (key === "exec") return (sql: string) => target.exec(scopedWrite(sql,scope.tenant,project.projectKey));
      const value = Reflect.get(target,key,target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    return {raw:handle,projectKey:project.projectKey,path:scope.database,...(readOnly ? {readOnly:true}: {})};
  } catch(e) {raw.close(); throw e;}
}
