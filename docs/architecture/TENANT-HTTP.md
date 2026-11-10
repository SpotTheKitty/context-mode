# Workstation tenant HTTP fork

Build server-http.mjs, hook-http.mjs and import.mjs with node build/build-http.mjs. The HTTP endpoint, header, tenant adapters, timeouts and data directory come from the caller-supplied workstation endpoint table. These entries are flat bundles.

The stdio entry retains its original schema and operation. HTTP stores tenant/project-scoped journal, sources, metadata and FTS rows in one SQLite database. A native one-shot hook posts its payload and tenant header to the shared server. Transport timeout, connection errors, non-success status and malformed responses return the selected adapter's allow encoding with exit zero, append one JSON line to dataDir/hook-errors.log and emit one stderr line. The table supplies hookTimeoutMs; successful server decisions retain their native encoding. The listener supports _workspace and _sessionId tool arguments or corresponding request metadata. Machine-wide doctor and upgrade operations use stdio.

# Bounded search (T230)

A ctx_search never holds the shared server. node:sqlite is synchronous, so a long statement run on the request path stops the one event loop: /healthz and every other tenant waited with it (up to 18 s on the 333 MB store, with single searches of 1 to 106 s). Two causes, both in the tenant-scoped views of src/core/store/tenant-store.ts:

- The chunks_tri view (line 95) filtered with `rowid IN (SELECT rowid FROM chunks)`. The tenant columns are UNINDEXED, so that subquery scanned every chunk of every tenant on each statement (the trigram statement took 8 to 68 s). It is now a correlated `EXISTS` lookup that runs once per trigram match (about 98 ms for the same statement).
- The chunks_vocab view (line 102) grouped every fts5vocab instance of every tenant, so one typo-correction lookup took up to 10 s per term. A term is now visible when one of its instances sits in a chunk of the tenant. `doc` and `cnt` are the shared index's counts, so typo correction (src/core/store/fts.ts typoTerms) uses `doc` only to order candidates at equal edit distance; the candidates themselves are still only terms the tenant indexed. This is the one behaviour change: a tie between equally close terms can resolve differently than with per-tenant counts.

The remaining bound is a worker pool. src/entries/search-pool.ts runs each ctx_search in a worker thread (src/entries/search-worker.ts, the same bundled file started with workerData.role, so a flat bundle needs nothing else). The caller gets an answer within `searchTimeoutMs` (default 20000): a result with isError set and the text "ctx_search timed out: ... (searchTimeoutMs)", never a dropped connection. Time spent waiting for a free worker counts toward that budget and the text then says it waited for a worker. `searchWorkers` (default 2; 0 turns the pool off and runs on the request path, unbounded) sets how many run at once. A timed-out worker is terminated, but node:sqlite has no interrupt, so a statement already inside SQLite finishes first; the pool keeps counting that thread until it exits so it never runs more than `searchWorkers` threads. A worker loads the whole entry on first use, which counts toward the first search's budget. The worker resolves the project itself from the request source: a resolved ProjectContext has lazy getters (containmentRoot runs `git worktree list`, about 180 ms) that structured clone would otherwise evaluate on the main thread.

Both settings are optional keys of contextMode in the endpoint table. Tests (tests/0002-store.test.mjs, "T230"): healthz and another tenant answer during a slow search; a control with no workers shows the loop held; a search over budget returns the timeout result; a stuck worker still counts and queued searches time out unstarted; the flat bundle runs a bounded search; typo correction offers only tenant terms; the trigram statement stays proportional to the tenant. Measured latencies are in docs/performance.md.

# One-time import

The flat import.mjs <endpoint-table> entry only plans; --apply imports read-only source snapshots into the shared SQLite file. contextMode.imports lists explicit old roots and their tenant. Missing roots are skipped; links inside a root are not followed. Original records are retained in the tenant/project-scoped legacy_records archive. Current journal/FTS rows retain their fields with remapped source IDs, and v1 session events become journal entries and searchable FTS content. Ancillary session metadata, resume snapshots and tool counters remain archived. Derived trigram indexes are rebuilt.

Private v1 content filenames are matched to project directories from that tenant's session metadata using canonical/legacy path hashes. Recorded UNC administrative-drive and slash-drive spellings are folded to local drives; historical T3 worktrees map to the existing project checkout, and vanished directories resolve to their nearest existing directory ancestor. Session metadata, resume and source rows provide workspace identity. Rows without an unambiguous project use SHA-256(tenant + ':legacy'), truncated to 16 hex characters.

Explicit importProjectMappings and importDatabaseMappings remain ownership overrides and take precedence over inference. Database overrides use the canonical absolute database path with forward slashes and can supply a tenant, workspace or projectKey. A shared source without a tenant still requires an explicit database ownership mapping. A shared database must have one verified owner before using a whole-file mapping; mixed-owner files require a reviewed split. No ownership is inferred from several clients configuring the same directory.

All sources are preflighted before destination creation. Each applied source is transactional; orphaned content rolls back its imported rows. A digest marker makes an unchanged rerun a no-op and rejects a changed source rather than synchronizing it. Quiesce the old writers and retain source backups during coordinator rollout. The importer never renames, checkpoints or writes a source database. Plans and tests do not run against the live workstation store.

Hook contract sources: src/core/contracts/types.ts (AdapterRow), src/adapters/claude-code.ts (encodeClaudeShape), src/core/hooks/fallback.ts (logHookError); https://code.claude.com/docs/en/hooks (empty output and exit zero continue); https://nodejs.org/api/sqlite.html (DatabaseSync readOnly and transactions).
# Fork suite maintenance (T225)

The Windows grandchild check polls for cleanup after cancellation within a bounded
PID_WAIT_MS window. A notification write is not an acknowledgement: parallel load
adds scheduling delay, and Windows taskkill has no POSIX KILL_GRACE_MS deadline.
The check still requires ten runs and zero surviving grandchildren. Runtime kill
behavior is unchanged; this corrects an unsupported one-second harness deadline.

The checkout manifest test checks consistency of the fork source manifests.
origin points to mksglu/context-mode; its v2.1.7 tag is not an ancestor of this
fork, whose version is 2.1.6. Requiring the fork to match that tag would claim
unmerged upstream code. The isolated release-script fixtures still test --check
against pushed tags. package-lock.json is optional, as in setVersions; it is not
tracked in this fork and installation uses --no-package-lock.

npm 11.20 blocks undeclared install scripts. package.json approves only the
reviewed esbuild@0.24.0 postinstall (node install.js), using npm install-scripts
approve esbuild. Its installer selects and validates the platform binary. No
blanket approval or warning suppression is used.

Sources: https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/
Context7 through litellm returned Monthly quota exceeded; retrieved via searchio.

The Copilot fire fixture imports the source hook using pathToFileURL: Windows drive paths are filesystem paths, not ESM module URLs. This fixes ERR_UNSUPPORTED_ESM_URL_SCHEME in the full suite without changing the hook.
The fake Copilot provider requests powershell/Get-Content on Windows and bash/cat elsewhere, matching the host's advertised shell. The disabled-hook control still requires the host's own large-output response.
Windows hook fuzz runs one child at a time. The former six-child pool produced five-second deadline failures in Kiro with four test files and in VS Code even with serial test files. CPU count did not represent available scheduling capacity. All 500 cases per host, fixed seeds, named regressions and the production HOOK_TIMEOUT_MS remain unchanged; only test load is serialized.

## Probe cleanup and suite boundary (T225 follow-up)

Copilot discovery previously killed only the command shim. A server descendant
could retain its stdout pipe and keep `0020-fire-hook-config.test.mjs` alive after
its tests reported failures. The fixture regression in
`0020-gates-pi-copilot-claude.test.mjs` reproduces that lifetime with a persistent
server. Discovery now destroys its pipe reader and terminates the owned process
tree; non-Windows children lead a process group so the existing killTree contract
applies. The regression checks the server PID is gone and the file exits naturally.
No force-exit option is used for acceptance.

Real installed-client fire checks are e2e, explicitly opt-in with named skip
reasons. Unit fixtures cover Copilot discovery and MCP registration failures and
the Kiro loader event/configuration contract. The bounded, locked full-suite
entrypoint and its skip/count semantics are documented in TEST-LAYOUT.md. This
follow-up keeps the workstation runtime pin at 645d7ca1 as requested; no runtime
was deployed from the checkout cleanup changes.

A second framed-transport fixture sends a notification and an unrelated response before the matching hooks.discover reply. The former first-frame parser returned undefined. Discovery now consumes complete frames until the matching request id; its API and deadline remain unchanged. Reference: https://www.jsonrpc.org/specification .

Long Windows unit runs hand off the existing T202 lock between completed files before its maximum hold could expire; they reacquire before starting another file. The shared record format and other checkouts are unchanged. Zcode schema fixtures are initialized from declarative registry data so setup rollback after an unrelated runtime probe cannot erase their input. See TEST-LAYOUT.md for budgets, compatibility and regression evidence.

The Copilot discovery descendant regression observes asynchronous Windows taskkill completion for at most thirty seconds. Its former one-second observation contradicted killTree's nonblocking D-1337-EXIT-SETTLE-1 contract and raced taskkill startup under machine load. Discovery and production hook deadlines remain unchanged; an owned descendant still alive after the bounded cleanup observation fails the test.
# Workspace resolution and client hooks

HTTP tools select `_workspace`, request `_meta.cwd`, Codex sandbox cwd, then the tool's `cwd`, in that order. When all are absent, the tenant's `defaultWorkspace`, server `defaultWorkspace`, session root from the endpoint table, then the server working directory provide a usable scope. A fallback is reported in the tool reply so callers can select a project explicitly. Tenant and project SQL isolation remains enforced; `ctx_stats` permits only the exact read-only `page_count` and `page_size` PRAGMAs needed for its size report.

The HTTP Claude Code forwarder adds `_workspace` from native PreToolUse `cwd` through `hookSpecificOutput.updatedInput` for context-mode tools. It preserves existing input, explicit workspaces, deny decisions and other hook fields. It also injects on the existing fail-open path. Other clients use native metadata or the reported server fallback.

Focused checks: `npm run typecheck` and `node --test tests/http-workspace.test.mjs`. The HTTP integration tests in `tests/0002-store.test.mjs` cover tenant isolation and flat deployment. No full suite is required for this focused change.
