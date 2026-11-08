# Performance

Every number here is copied from a measured source in this repo. Each row names the source, the date and the agent version.
A number with no measured source is not written here. Budgets come from `src/core/contracts/constants.ts` and TECH-SPEC §1 (GS6).

## Hook latency (GS6)

Source: `docs/architecture/TECH-SPEC.md` §1.1 (M7 sign-off status, M7-S4). Measured 2026-10-20 on `origin/v2-design`, macOS, Node 26, one machine, other load not checked.
Agent: Claude Code (agent version not stated in the source). GS6 status: **FAIL**.

| Measure | Measured | Budget | Result |
|---|---|---|---|
| Claude Code `mcp_tool` hook, p95 wall (`T-GS6`, n=200) | 41 ms | `HOOK_P95_MS` 40 ms | FAIL |
| Command hooks, p95 wall (`T-GS6`) | 43 ms | `HOOK_COMBINED_P95_MS` 60 ms | pass |
| Command hooks, CPU over bare Node (`T-GS6`) | 20 ms | `HOOK_CPU_OVER_NODE_MS` 20 ms | pass |
| `T-F1` Case B, 65536 B PostToolUse, p95 wall (live run) | 62 ms | `HOOK_COMBINED_P95_MS` 60 ms | FAIL |
| `bench/hook-index.mjs`, 64 KB, p95 (50 runs x 3, loadavg 4.8 to 5.6) | 50.5 to 55.0 ms (before the fix: 58.4 to 82.7 ms) | none set for this script | as measured |
| `bench/hook-index.mjs`, 1 MiB, p95 | 113.8 to 120.8 ms (before the fix: 150.0 to 154.7 ms) | `HOOK_COMBINED_P95_MS` 60 ms | about 2x over |
| Live 1 MiB check | 134 ms | `HOOK_COMBINED_P95_MS` 60 ms | over |
| Bare Node, p95 | 31 to 33 ms | reference only | - |

The misses at 64 KB and in `T-GS6` are 1 to 2 ms over the budget. The 1 MiB case is about 2x over. Open items: `https://github.com/mksglu/context-mode/blob/274600e2ffab843e89c1dfa09b0d649e650c962f/.impl/BLOCKED-M7.md`; fixes so far: D-M7-FT-1, D-M7-FT-2 in `docs/architecture/modules/DEVIATIONS.md`.

## Tenant HTTP search latency (T230)

Source: `bench` over HTTP against a copy of the live 333 MB multi-tenant store (read-only copy; the live store was not touched), MCP `tools/call` `ctx_search`, 14 queries (worktree and project scope) per round, tenant `claude`, `/healthz` polled every 25 ms during the run. Measured 2026-11-08, Node 26.12.0 (SQLite 3.54.0), one machine, Windows, other delegates' test runs were using the machine (load not controlled).

| Measure | Before (base `aa61360c`) | After (T230 bundle) |
|---|---|---|
| ctx_search p50 | 6,456 ms (n=28); 5,419 ms (n=14, earlier run) | 237 ms (n=42) |
| ctx_search p95 | 96,534 ms (n=28); 88,579 ms (n=14) | 703 ms (n=42) |
| ctx_search max | 106,253 ms | 1,662 ms |
| `/healthz` max while searching | 17,992 ms (15 polls); 16,893 ms (8 polls) | 42 ms (391 polls) |
| `/healthz` p95 while searching | 17,992 ms | 2 ms |
| Trigram statement alone (`stat('vmStep')` 7,278 on 2 tenants x 400 chunks before, under 1,500 after) | 67,681 ms | about 98 ms |
| Typo-correction vocabulary lookup | over 180 s | 371 ms |

With n of 14 to 42 the p95 is one of the slowest few queries, not a stable percentile. An earlier run of the final code measured p50 207 ms, p95 400 ms and `/healthz` max 45 ms (printed, not saved), and a run of the first fix measured p50 223 ms, p95 497 ms (n=42). The main thread's event-loop delay in the final run had max 827 ms and p99 39 ms; `/healthz` did not see it. Causes and design: `docs/architecture/TENANT-HTTP.md` "Bounded search (T230)".

## Context bytes

Final A/B (`bench/live/results/ab-final.json`, `bench/RESULTS.md`, 2026-10-20, Claude Code 2.1.303, claude-sonnet-5-5 low, 54 sessions): median tool_result bytes off 46.5, with the plugin 31. On multi-1 the tool_result bytes drop from 6,819 to 583. Median session tokens: off 36,217; with the plugin 38,252.

Saving score, median of 3 runs (`bench/saving-score.mjs`, 2026-10-21, `980272a5`): M1 94.21, M2 87.23, `guardsOk` false (gate guard). Final A/B (`bench/live/results/ab-final2.json`, 2026-10-21): large tasks median tool_result bytes off 4,694.5, with the plugin 734.5.

See `bench/RESULTS.md` for the offline replay (byte count over real transcripts) and the live runs, and `bench/routing-results.md` for live routing.
A short summary is in the README "Benchmarks" section and in `https://github.com/mksglu/context-mode/blob/274600e2ffab843e89c1dfa09b0d649e650c962f/docs/v2/LAUNCH.md`.
