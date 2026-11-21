import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
