import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";

const serverMod = await import(process.env.CM_SERVER_ENTRY
  ? pathToFileURL(process.env.CM_SERVER_ENTRY).href
  : "../src/entries/server-http.ts");
const { listenHttp } = serverMod;
const poolMod = await import(process.env.CM_POOL_ENTRY
  ? pathToFileURL(process.env.CM_POOL_ENTRY).href
  : "../src/entries/search-pool.ts");
const { RequestPool } = poolMod;

test("heavy MCP indexing stays off the listener while health, ready, hooks, covering stats, and worker crash recovery all hold", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-mt-"));
  const dataDir = join(root, "data");
  // ~6 MB of text (~5,000 paragraphs): heavy enough to block a single-threaded listener for >3 s on the pin.
  const para = Array.from({ length: 12 }, (_, l) => `Line ${l} alpha distributed worker pool healthz responsiveness benchmark text payload.`).join("\n") + "\n\n";
  writeFileSync(join(root, "heavy.txt"), para.repeat(5000), "utf8");

  const errorLogs = [];
  const origError = console.error;
  console.error = (...args) => {
    errorLogs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };

  const spawned = [];
  let server;
  let maxLoopLag = 0;
  let lastTick = performance.now();
  const loopWatch = setInterval(() => {
    const now = performance.now();
    maxLoopLag = Math.max(maxLoopLag, now - lastTick - 20);
    lastTick = now;
  }, 20);

  try {
    server = await listenHttp(
      {
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        tenantHeader: "x-context-tenant",
        dataDir,
        maxRequestBytes: 16_000_000,
        hookTimeoutMs: 2000,
        toolWorkers: 2,
        searchWorkers: 2,
        hookWorkers: 2,
        tenants: {
          alpha: { agent: "claude-code", toolPrefix: "mcp__contextMode__" },
          beta: { agent: "claude-code", toolPrefix: "mcp__contextMode__" },
        },
      },
      {
        onWorker(worker, pool) {
          spawned.push({ worker, pool, threadId: worker.threadId });
        },
      },
    );
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const callTool = async (tenant, name, args) => {
      const res = await fetch(baseUrl + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json,text/event-stream",
          "x-context-tenant": tenant,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { ...args, _workspace: root, _sessionId: "mt-" + tenant } },
        }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const hookCheck = async (tenant, i) => {
      const t0 = performance.now();
      const res = await fetch(baseUrl + "/mcp/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", "x-context-tenant": tenant },
        body: JSON.stringify({
          adapter: "claude-code",
          raw: {
            hook_event_name: "PreToolUse",
            session_id: "mt-" + tenant,
            cwd: root,
            tool_name: "WebFetch",
            tool_input: { url: `https://example.com/${i}` },
          },
        }),
        signal: AbortSignal.timeout(1500),
      });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.match(json.stdout, /deny/);
      return performance.now() - t0;
    };

    // Warm hook workers once so cold module load is outside the steady-state latency check.
    await hookCheck("beta", 0);

    // 1. Start heavy ctx_index and run 20 /healthz + 20 PreToolUse hook checks while it is in flight.
    let indexDone = false;
    const heavy = callTool("alpha", "ctx_index", { path: "heavy.txt" }).then((r) => { indexDone = true; return r; });
    await new Promise((r) => setTimeout(r, 150));

    const healthMs = [];
    const hookMs = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const [hRes, hk] = await Promise.all([
        fetch(baseUrl + "/healthz", { signal: AbortSignal.timeout(1500) }).then(async (r) => {
          assert.equal(r.status, 200);
          assert.equal(await r.text(), "ok");
          return performance.now() - t0;
        }),
        hookCheck("beta", i + 1),
      ]);
      healthMs.push(hRes);
      hookMs.push(hk);
    }
    assert.equal(indexDone, false, "probes should complete while heavy ctx_index is still running");
    assert.ok(Math.max(...healthMs) < 200, `healthz stalled: max=${Math.max(...healthMs).toFixed(1)} ms`);
    assert.ok(Math.max(...hookMs) < 200, `hook check stalled: max=${Math.max(...hookMs).toFixed(1)} ms`);

    const heavyReply = await heavy;
    assert.equal(heavyReply.result.isError, false, JSON.stringify(heavyReply));
    assert.ok(maxLoopLag < 200, `main event loop stalled for ${maxLoopLag.toFixed(1)} ms`);

    // Constant-time readiness endpoint: validates tenant without touching SQLite or worker pools.
    assert.equal((await fetch(baseUrl + "/mcp/ready")).status, 403);
    const readyRes = await fetch(baseUrl + "/mcp/ready", { headers: { "x-context-tenant": "beta" } });
    assert.equal(readyRes.status, 200);
    assert.deepEqual(await readyRes.json(), { ok: true, tenant: "beta", agent: "claude-code" });

    // 2. ctx_stats uses covering index idx_events_tenant_stats and does not bloat events with self-report rows.
    const statsBefore = new DatabaseSync(join(dataDir, "context.db"), { readOnly: true });
    let beforeEvents;
    try {
      beforeEvents = statsBefore.prepare("SELECT COUNT(*) AS n FROM events WHERE tool = 'ctx_stats'").get().n;
      const idx = statsBefore.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_tenant_stats'").get();
      assert.ok(idx, "expected covering index idx_events_tenant_stats");
    } finally { statsBefore.close(); }
    const statsReply = await callTool("alpha", "ctx_stats", {});
    assert.equal(statsReply.result.isError, false, JSON.stringify(statsReply));
    const statsAfter = new DatabaseSync(join(dataDir, "context.db"), { readOnly: true });
    try {
      assert.equal(statsAfter.prepare("SELECT COUNT(*) AS n FROM events WHERE tool = 'ctx_stats'").get().n, beforeEvents);
    } finally { statsAfter.close(); }

    // 3. Kill a tools worker mid-call: server stays up, crash + replacement are logged loudly, next call succeeds.
    const victim = spawned.find((w) => w.pool === "tools");
    assert.ok(victim, "expected a live tools worker");
    const killedCall = callTool("alpha", "ctx_index", { path: "heavy.txt" });
    await new Promise((r) => setTimeout(r, 150));
    await victim.worker.terminate();
    const killedReply = await killedCall;
    assert.equal(killedReply.result.isError, true);
    await new Promise((r) => setTimeout(r, 100));

    assert.equal((await fetch(baseUrl + "/healthz")).status, 200);
    assert.ok(errorLogs.some((l) => l.includes('"event":"worker_crash"') && l.includes(`"threadId":${victim.threadId}`)), "missing worker_crash log");
    assert.ok(errorLogs.some((l) => l.includes('"event":"worker_replaced"') && l.includes(`"oldThreadId":${victim.threadId}`)), "missing worker_replaced log");

    const nextWrite = await callTool("beta", "ctx_index", { content: "beta recovered unique9876", source: "recovered" });
    assert.equal(nextWrite.result.isError, false, JSON.stringify(nextWrite));
    const nextSearch = await callTool("beta", "ctx_search", { queries: ["unique9876"] });
    assert.equal(nextSearch.result.isError, false, JSON.stringify(nextSearch));
    assert.match(nextSearch.result.content[0].text, /unique9876/);
  } finally {
    clearInterval(loopWatch);
    console.error = origError;
    if (server) await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

// Helper for round-2 regression tests below.
async function withTestServer(configPatch, fn, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "cm-mt-r2-"));
  const dataDir = join(root, "data");
  const config = {
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    tenantHeader: "x-context-tenant",
    dataDir,
    maxRequestBytes: 32_000_000,
    toolWorkers: 2,
    searchWorkers: 2,
    hookWorkers: 2,
    hookTimeoutMs: 2000,
    tenants: {
      alpha: { agent: "claude-code", toolPrefix: "mcp__contextMode__" },
      beta: { agent: "claude-code", toolPrefix: "mcp__contextMode__" },
    },
    ...configPatch,
  };
  let server;
  try {
    server = await listenHttp(config, options);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const callTool = async (tenant, name, args = {}) => {
      const res = await fetch(baseUrl + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json,text/event-stream",
          "x-context-tenant": tenant,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { ...args, _workspace: root, _sessionId: "r2-" + tenant } },
        }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    return await fn({ root, dataDir, dbPath: join(dataDir, "context.db"), baseUrl, config, callTool });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
}

test("finding 1: concurrent ctx_purge and mid-index worker crash leave no orphan chunks or partial sources", async () => {
  const payload = Array.from({ length: 6000 }, (_, i) => ("chunk " + i + " cedar consistency payload line\n").repeat(24) + "\n").join("");

  // 1a. Concurrent purge between batches invalidates the pending reservation and leaves 0 orphan chunks.
  let releaseWorker;
  let observe = false;
  let releaseResolve;
  const firstRelease = new Promise((r) => { releaseResolve = r; });
  await withTestServer({}, async ({ root, dbPath, callTool }) => {
    writeFileSync(join(root, "race.txt"), payload, "utf8");
    assert.equal((await callTool("alpha", "ctx_index", { content: "warm", source: "warm" })).result.isError, false);
    observe = true;
    const indexing = callTool("alpha", "ctx_index", { path: "race.txt" });
    await Promise.race([firstRelease, new Promise((_, rej) => setTimeout(() => rej(new Error("no write lock release")), 10000))]);
    const purge = await callTool("alpha", "ctx_purge", { source: "race.txt" });
    const idxRes = await indexing;
    assert.equal(purge.result.isError, false);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const orphanChunks = db.prepare("SELECT count(*) AS n FROM chunks c LEFT JOIN sources s ON s.id = c.source_id WHERE s.id IS NULL").get().n;
      const src = db.prepare("SELECT chunk_count, (SELECT count(*) FROM chunks WHERE source_id = s.id) AS actual FROM sources s WHERE label = 'race.txt'").get();
      assert.equal(orphanChunks, 0, "purge during indexing must not leave orphan chunks");
      if (src !== undefined) assert.equal(src.actual, src.chunk_count, "published source must match actual chunk count");
      else if (!idxRes.result.isError) {
        // Only valid if purge ran after all 6000 chunks were published and deleted all 6001 rows (source + chunks).
        assert.match(purge.result.content[0].text, /deleted 6001 rows/, "if ctx_index succeeded, purge must have deleted the full source");
      }
    } finally { db.close(); }
  }, {
    onWorker(worker, pool) {
      if (pool === "tools") {
        worker.on("message", (m) => {
          if (observe && !releaseWorker && m.__cmWriteLock === "release") { releaseWorker = worker; releaseResolve(); }
        });
      }
    },
  });

  // 1b. Worker terminated mid-index leaves no visible partial source row and no orphan chunks.
  let crashWorker;
  let observeCrash = false;
  let crashResolve;
  const crashRelease = new Promise((r) => { crashResolve = r; });
  await withTestServer({}, async ({ root, dbPath, callTool }) => {
    writeFileSync(join(root, "crash.txt"), payload, "utf8");
    assert.equal((await callTool("alpha", "ctx_index", { content: "warm", source: "warm" })).result.isError, false);
    observeCrash = true;
    const indexing = callTool("alpha", "ctx_index", { path: "crash.txt" });
    await Promise.race([crashRelease, new Promise((_, rej) => setTimeout(() => rej(new Error("no write lock release")), 10000))]);
    await crashWorker.terminate();
    const idxRes = await indexing;
    assert.equal(idxRes.result.isError, true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const orphanChunks = db.prepare("SELECT count(*) AS n FROM chunks c LEFT JOIN sources s ON s.id = c.source_id WHERE s.id IS NULL").get().n;
      const src = db.prepare("SELECT chunk_count, (SELECT count(*) FROM chunks WHERE source_id = s.id) AS actual FROM sources s WHERE label = 'crash.txt'").get();
      assert.equal(orphanChunks, 0, "worker crash mid-index must not leave orphan chunks");
      assert.equal(src, undefined, "worker crash mid-index must not leave a partial source row");
    } finally { db.close(); }
  }, {
    onWorker(worker, pool) {
      if (pool === "tools") {
        worker.on("message", (m) => {
          if (observeCrash && !crashWorker && m.__cmWriteLock === "release") { crashWorker = worker; crashResolve(); }
        });
      }
    },
  });
});

test("finding 2: HTTP timeout cancels per-job AbortController and stops sandbox child before it writes", async () => {
  await withTestServer({ toolWorkers: 1, toolTimeoutMs: 1200 }, async ({ root, callTool, baseUrl }) => {
    const started = join(root, "started.txt");
    const finished = join(root, "finished.txt");
    const code = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "1"); setTimeout(() => fs.writeFileSync(${JSON.stringify(finished)}, "1"), 2500);`;
    const res = await callTool("alpha", "ctx_execute", { language: "javascript", code, timeoutMs: 10000 });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /timed out/);
    assert.equal(existsSync(started), true, "sandbox child should have started before timeout");
    assert.equal(existsSync(finished), false, "sandbox child must not have finished at timeout reply");
    assert.equal((await fetch(baseUrl + "/healthz")).status, 200);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(existsSync(finished), false, "sandbox child must be stopped and not write after timeout reply");
  });
});

test("finding 3: permanent worker startup error does not spin an idle restart loop or spam logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-mt-loop-"));
  const badWorker = join(dir, "crash.mjs");
  writeFileSync(badWorker, 'throw new Error("permanent startup failure");\n', "utf8");
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.map(String).join(" "));
  let spawned = 0;
  const pool = new RequestPool(badWorker, 1, "hook", {
    onWorker() { spawned += 1; },
  });
  try {
    pool.warm(1);
    await new Promise((r) => setTimeout(r, 450));
    assert.ok(spawned <= 2, `expected bounded spawns on startup failure, got ${spawned}`);
    assert.ok(logs.length <= 2, `expected once-per-outage logging, got ${logs.length} lines: ${logs.join(" | ")}`);
  } finally {
    await pool.close();
    console.error = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 4: missing idx_events_tenant_stats does not block request open and buildStatsIndex creates it with logs", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-mt-f4-"));
  const dataDir = join(root, "data");
  const dbPath = join(dataDir, "context.db");
  const config = {
    host: "127.0.0.1", port: 0, path: "/mcp", tenantHeader: "x-context-tenant", dataDir,
    maxRequestBytes: 16_000_000, toolWorkers: 2, searchWorkers: 2, hookWorkers: 2, hookTimeoutMs: 2000,
    tenants: { alpha: { agent: "claude-code" } },
  };
  const logs = [];
  const orig = console.error;
  try {
    // Seed a migrated tenant store, then drop idx_events_tenant_stats to simulate a pre-upgrade store.
    let s1 = await listenHttp(config);
    try {
      const res = await fetch(`http://127.0.0.1:${s1.address().port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json,text/event-stream", "x-context-tenant": "alpha" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ctx_index", arguments: { content: "seed", source: "s", _workspace: root, _sessionId: "s1" } } }),
      });
      assert.equal(res.status, 200);
    } finally { await new Promise((r) => s1.close(r)); }
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("DROP INDEX IF EXISTS idx_events_tenant_stats");
      assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_events_tenant_stats'").get(), undefined);
    } finally { raw.close(); }

    // Reopen and call ctx_stats: must NOT acquire write lock or build index in the request path.
    const lockAcquires = [];
    const s2 = await listenHttp(config, {
      onWorker(worker, pool) {
        worker.on("message", (m) => { if (m.__cmWriteLock === "acquire") lockAcquires.push(pool); });
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${s2.address().port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json,text/event-stream", "x-context-tenant": "alpha" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ctx_stats", arguments: { _workspace: root, _sessionId: "s1" } } }),
      });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.result.isError, false);
    } finally { await new Promise((r) => s2.close(r)); }
    assert.deepEqual(lockAcquires, [], "ctx_stats on a store without idx_events_tenant_stats must not take the write lock");

    const checkMissing = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(checkMissing.prepare("SELECT name FROM sqlite_master WHERE name='idx_events_tenant_stats'").get(), undefined, "index must not be created inside request open");
    } finally { checkMissing.close(); }

    // Explicit upgrade builds it once and logs start + end with durationMs.
    assert.equal(typeof serverMod.buildStatsIndex, "function", "buildStatsIndex must be exported");
    console.error = (...a) => logs.push(a.map(String).join(" "));
    const built = serverMod.buildStatsIndex(dbPath);
    assert.equal(built.status, "created");
    assert.ok(logs.some((l) => l.includes('"event":"stats_index_build_start"')), "missing build start log");
    assert.ok(logs.some((l) => l.includes('"event":"stats_index_build_end"') && l.includes('"durationMs"')), "missing build end log");
    const checkBuilt = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.ok(checkBuilt.prepare("SELECT name FROM sqlite_master WHERE name='idx_events_tenant_stats'").get());
    } finally { checkBuilt.close(); }
  } finally {
    console.error = orig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("finding 5: failed bind does not leak pre-warmed worker threads", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-mt-f5-"));
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const spawned = [];
  try {
    await assert.rejects(
      listenHttp(
        {
          host: "127.0.0.1", port: occupied.address().port, path: "/mcp", tenantHeader: "x-context-tenant",
          dataDir: join(root, "data"), maxRequestBytes: 1_000_000, tenants: { t: { agent: "claude-code" } },
        },
        { onWorker(w) { spawned.push(w); } },
      ),
      { code: "EADDRINUSE" },
    );
    const alive = spawned.filter((w) => w.threadId !== -1);
    assert.equal(alive.length, 0, `expected 0 leaked workers after failed bind, found ${alive.length}`);
  } finally {
    await Promise.allSettled(spawned.map((w) => w.terminate()));
    await new Promise((r) => occupied.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

test("finding 6: worker ceilings are enforced, spawn errors are handled, and endpoint tables reject searchWorkers: 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-mt-f6-"));
  const base = {
    host: "127.0.0.1", port: 0, path: "/mcp", tenantHeader: "x-context-tenant",
    dataDir: join(root, "data"), maxRequestBytes: 1_000_000, tenants: { t: { agent: "claude-code" } },
  };
  const orig = console.error;
  const logs = [];
  try {
    for (const patch of [{ toolWorkers: 1e20 }, { searchWorkers: 1e20 }, { hookWorkers: 1e20 }, { toolWorkers: 999 }]) {
      let leakedServer = null;
      try {
        leakedServer = await listenHttp({ ...base, ...patch });
        assert.fail(`expected listenHttp to reject ${JSON.stringify(patch)}`);
      } catch (err) {
        if (leakedServer) {
          await new Promise((r) => leakedServer.close(r));
          throw err;
        }
        assert.match(String(err.message), /invalid contextMode/);
      }
    }
    assert.equal(typeof serverMod.configFromEndpointTable, "function", "configFromEndpointTable must be exported");
    assert.throws(
      () => serverMod.configFromEndpointTable({ contextMode: { ...base, searchWorkers: 0 } }),
      /searchWorkers/,
    );
    // Synchronous Worker construction error is handled and logged, not unhandled.
    console.error = (...a) => logs.push(a.map(String).join(" "));
    const badPool = new RequestPool("invalid\0worker\0path", 1, "tools");
    try {
      const out = await badPool.run({}, 2000);
      assert.equal(out.kind, "failed");
      assert.ok(logs.some((l) => l.includes('"event":"worker_spawn_failed"')), "expected worker_spawn_failed log");
    } finally {
      await badPool.close();
    }
  } finally {
    console.error = orig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("finding 7: ctx_stats keeps case-insensitive ctx_ classification and excludes ctx_stats rows from active span", async () => {
  await withTestServer({}, async ({ root, dbPath, callTool }) => {
    assert.equal((await callTool("alpha", "ctx_index", { content: "seed text", source: "seed" })).result.isError, false);
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT session_id, worktree, project_key FROM events WHERE tool='ctx_index' LIMIT 1").get();
      const t0 = 1700000000000;
      db.prepare("UPDATE events SET tool='CTX_INDEX', sandbox_bytes=10000, returned_bytes=10, created_at=? WHERE tool='ctx_index'").run(t0);
      db.prepare(
        "INSERT INTO events(session_id, worktree, agent, kind, tool, turn, sandbox_bytes, returned_bytes, body, created_at, accessed_at, tenant, project_key) " +
        "VALUES(?, ?, 'claude-code', 'cmd', 'ctx_stats', 1, 0, 1200, 'report', ?, ?, 'alpha', ?)",
      ).run(row.session_id, row.worktree, t0 + 60 * 60_000, t0 + 60 * 60_000, row.project_key);
    } finally { db.close(); }

    const res = await callTool("alpha", "ctx_stats", {});
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.doesNotMatch(text, /large output cut down/, "uppercase CTX_INDEX must not be counted as a hook replacement");
    assert.match(text, /This session · 1 call · <1m active/, "historical ctx_stats row must not extend active span");
  });
});
