import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { listenHttp } = await import(process.env.CM_SERVER_ENTRY
  ? pathToFileURL(process.env.CM_SERVER_ENTRY).href
  : "../src/entries/server-http.ts");

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
