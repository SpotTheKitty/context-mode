import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listenHttp } from "../src/entries/server-http.ts";
import { REPLACE_TRIGGER_BYTES } from "../src/core/contracts/constants.ts";

test("the first search of a diverted memory result reaches the model", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cm-search-followup-"));
  const tenant = { agent: "claude-code", toolPrefix: "mcp__contextMode__" };
  const server = await listenHttp({
    host: "127.0.0.1", port: 0, path: "/mcp", tenantHeader: "x-context-tenant",
    maxRequestBytes: 1_000_000, dataDir: join(workspace, "data"), tenants: { claude: tenant },
  });
  try {
    const post = async (suffix, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp${suffix}`, {
        method: "POST",
        headers: {
          "content-type": "application/json", accept: "application/json,text/event-stream",
          "x-context-tenant": "claude",
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const outputHook = (tool_name, tool_input, tool_response) => post("/hooks", {
      hook_event_name: "PostToolUse", session_id: "memory-test", cwd: workspace,
      tool_name, tool_input, tool_response,
    });

    const queries = Array.from({ length: 20 }, (_, index) => `milestone${index}proof`);
    const memory = queries.map((word) =>
      `### ${word}\n${(`The ${word} was recorded in memory.\n`).repeat(12)}`).join("\n");
    const diverted = await outputHook("mcp__fastmcp_gateway__mem_search", { limit: 20 }, [{ type: "text", text: memory }]);
    const preview = JSON.parse(diverted.stdout).hookSpecificOutput.updatedToolOutput[0].text;
    const handle = /source:"(s[0-9a-z]+)"\}\) searches the whole output/.exec(preview)?.[1];
    assert.ok(handle, preview);

    const toolArgs = { queries, source: handle, _workspace: workspace, _sessionId: "memory-test" };
    const reply = await post("", {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "ctx_search", arguments: toolArgs },
    });
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    const contents = reply.result.content;
    assert.match(contents[0].text, /The milestone0proof was recorded in memory/);
    assert.ok(Buffer.byteLength(contents[0].text) > REPLACE_TRIGGER_BYTES, "follow-up must cross the diversion threshold");
    const afterSearch = await outputHook(tenant.toolPrefix + "ctx_search", toolArgs, contents);
    assert.equal(afterSearch.stdout, "", "the hook re-diverted its own search response");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
});

// T1007: the pointer a diverted result ends with is a call that works as written. The session's working folder is outside the
// server's session root (on the workstation: a T3 worktree outside F:/Projects); the pointer must carry that folder, and its
// first query must not be empty.
test("the diversion pointer reaches the stored text from a folder outside the session root", async () => {
  const base = mkdtempSync(join(tmpdir(), "cm-pointer-ws-"));
  const sessionRoot = join(base, "projects");
  const outside = join(base, "outside-worktree");
  mkdirSync(sessionRoot);
  mkdirSync(outside);
  const server = await listenHttp({
    host: "127.0.0.1", port: 0, path: "/mcp", tenantHeader: "x-context-tenant", sessionRoot,
    maxRequestBytes: 1_000_000, dataDir: join(base, "data"), tenants: { claude: { agent: "claude-code", toolPrefix: "mcp__contextMode__" } },
  });
  try {
    const post = async (suffix, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json,text/event-stream", "x-context-tenant": "claude" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const memory = Array.from({ length: 20 }, (_, i) => `### milestone${i}proof\n${`The milestone${i}proof was recorded in memory.\n`.repeat(12)}`).join("\n");
    const diverted = await post("/hooks", {
      hook_event_name: "PostToolUse", session_id: "pointer-test", cwd: outside,
      tool_name: "mcp__fastmcp_gateway__mem_search", tool_input: { query: "milestone proof", limit: 20 },
      tool_response: [{ type: "text", text: memory }],
    });
    const preview = JSON.parse(diverted.stdout).hookSpecificOutput.updatedToolOutput[0].text;
    const call = /(ctx_search\(\{.*\}\)) searches the whole output/.exec(preview)?.[1];
    assert.ok(call, preview);
    const args = new Function(`const ctx_search = (a) => a; return ${call};`)();
    assert.notEqual(args.queries[0], "", "the first suggested query is empty: " + call);

    const reply = await post("", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ctx_search", arguments: args } });
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    const text = reply.result.content[0].text;
    assert.doesNotMatch(text, /Workspace fallback|No hits/, `the pointer, run as written, found nothing: ${call}\n${text}`);
    assert.match(text, /milestone0proof/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});

// T1011: a memory search reply (about 1 KB a row, 8.2 KB at limit 8) is returned whole when the data table lists the tool in
// inlineLimits; the same size from any other tool is still diverted at the general threshold.
test("a tool listed in inlineLimits is returned whole up to its limit; others are still diverted", async () => {
  const base = mkdtempSync(join(tmpdir(), "cm-inline-limit-"));
  const server = await listenHttp({
    host: "127.0.0.1", port: 0, path: "/mcp", tenantHeader: "x-context-tenant", inlineLimits: { "mcp__fastmcp-gateway__mem_search": 24576 },
    maxRequestBytes: 1_000_000, dataDir: join(base, "data"), tenants: { claude: { agent: "claude-code", toolPrefix: "mcp__contextMode__" } },
  });
  try {
    const hook = async (tool_name, text) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp/hooks`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json,text/event-stream", "x-context-tenant": "claude" },
        body: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "inline-test", cwd: base, tool_name, tool_input: { query: "memory", limit: 8 }, tool_response: [{ type: "text", text }] }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const rows = Array.from({ length: 8 }, (_, i) => `### row${i}\n${`memory row ${i} text.\n`.repeat(55)}`).join("\n");
    assert.ok(Buffer.byteLength(rows) > 8000 && Buffer.byteLength(rows) < 24576, "fixture is about 8 KB");
    assert.equal((await hook("mcp__fastmcp-gateway__mem_search", rows)).stdout, "", "the memory search reply was diverted");
    assert.match((await hook("mcp__fastmcp-gateway__mem_other", rows)).stdout, /updatedToolOutput/, "another tool of the same size was not diverted");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});

// T1021: between a tool's whole limit and its band's upToBytes, a hook returns the excerpts that best match the call's own arguments
// (about returnBytes of them) plus the pointer; above upToBytes the small diversion is unchanged.
test("a result in a tool's excerpt band returns the excerpts that match its arguments plus the pointer", async () => {
  const base = mkdtempSync(join(tmpdir(), "cm-excerpt-band-"));
  const server = await listenHttp({
    host: "127.0.0.1", port: 0, path: "/mcp", tenantHeader: "x-context-tenant", excerptBands: { "mcp__fastmcp-gateway__mem_search": { upToBytes: 65536, returnBytes: 1500 } },
    maxRequestBytes: 1_000_000, dataDir: join(base, "data"), tenants: { claude: { agent: "claude-code", toolPrefix: "mcp__contextMode__" } },
  });
  try {
    const hook = async (text) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp/hooks`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json,text/event-stream", "x-context-tenant": "claude" },
        body: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "band-test", cwd: base, tool_name: "mcp__fastmcp-gateway__mem_search", tool_input: { query: "milestone17proof", limit: 40 }, tool_response: [{ type: "text", text }] }),
      });
      assert.equal(response.status, 200);
      return JSON.parse((await response.json()).stdout).hookSpecificOutput.updatedToolOutput[0].text;
    };
    const rows = (count) => Array.from({ length: count }, (_, i) => `### milestone${i}proof\n${`The milestone${i}proof was recorded in memory.\n`.repeat(8)}`).join("\n");
    const band = await hook(rows(60));
    assert.ok(Buffer.byteLength(rows(60)) > REPLACE_TRIGGER_BYTES && Buffer.byteLength(rows(60)) <= 65536, "fixture sits in the band");
    assert.match(band, /The milestone17proof was recorded in memory/, "the excerpt that matches the call's argument is returned");
    assert.match(band, /ctx_search\(\{.*\}\) searches the whole output/, "the pointer for the rest is returned");
    assert.ok(Buffer.byteLength(band) > 600 && Buffer.byteLength(band) < 2000, `excerpts of about returnBytes, got ${Buffer.byteLength(band)}`);
    const above = await hook(rows(400));
    assert.ok(Buffer.byteLength(rows(400)) > 65536, "fixture is above the band");
    assert.ok(Buffer.byteLength(above) < Buffer.byteLength(band) / 2, "above upToBytes the small diversion is unchanged");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});
