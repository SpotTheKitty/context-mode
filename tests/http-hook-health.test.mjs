import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import test from "node:test";

const { listenHttp } = await import(process.argv[2]
  ? pathToFileURL(process.argv[2]).href
  : "../src/entries/server-http.ts");

test("health answers while another SQLite connection holds up hook indexing", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cm-hook-health-"));
  const dataDir = join(workspace, "data");
  const server = await listenHttp({
    host: "127.0.0.1", port: 0, path: "/mcp", tenantHeader: "x-context-tenant",
    maxRequestBytes: 1_000_000, hookTimeoutMs: 2000, dataDir, tenants: { claude: { agent: "claude-code" } },
  });
  let writer;
  let pendingHook;
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const hook = async () => {
      const response = await fetch(url + "/mcp/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", "x-context-tenant": "claude" },
        body: JSON.stringify({
          hook_event_name: "PostToolUse", session_id: "health-test", cwd: workspace,
          tool_name: "mcp__fastmcp_gateway__mem_search", tool_input: { limit: 20 },
          tool_response: "A stored memory result with matching text.\n".repeat(200),
        }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.match((await hook()).stdout, /searches the whole output/);
    writer = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData);
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      parentPort.once("message", () => { db.exec("COMMIT"); db.close(); });
      setTimeout(() => parentPort.emit("message"), 3000).unref();
    `, { eval: true, workerData: join(dataDir, "context.db") });
    await once(writer, "message");

    const started = performance.now();
    let indexed = false;
    pendingHook = hook().then((reply) => { indexed = true; return reply; });
    // Queue the health request after the hook has reached the listener.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await fetch(url + "/healthz", { signal: AbortSignal.timeout(1200) });
    assert.equal(await health.text(), "ok");
    assert.ok(performance.now() - started < 1500, "hook indexing stalled the HTTP listener");
    assert.equal(indexed, false, "health should answer before the write lock is released");
    writer.postMessage("release");
    assert.match((await pendingHook).stdout, /searches the whole output/);
  } finally {
    await writer?.terminate();
    await pendingHook?.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
});
