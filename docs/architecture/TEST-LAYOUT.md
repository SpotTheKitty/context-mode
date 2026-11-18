# Test layout: one file per ADR/PRD area

Status: accepted 2026-10-30, move done. Decision record: [ADR-0024](adr/0024-test-layout-by-adr.md).

## The rule

- A test file owns one ADR or PRD area (or one TECH-SPEC GP case). The table below lists every file.
- A fix or a feature does not get a new test file. Put its red test in the file that owns its ADR area.
- Name a file after the area, never after a fix, an issue number or a feature.
- Split an area into more files only when one file would be the long pole of the parallel run. Name the parts by ADR section.
- Files run in parallel (node --test). Inside a file, tests run in order. Keep a file under the long pole (hook-fuzz, 51 s).
- Shared helpers live in tests/_lib/. One copy of each. Add a helper there when two area files need the same body.
- Layers from ADR-0003 stay. A file under e2e/ never imports from src/. Tests that import src/ stay in tests/.
- Frozen: e2e/live/compact-hard and bench/m2 are never edited.

## How to add a red test

1. Find the area in the table (ADR number, PRD section or GP case).
2. Open the file. Find the describe block of the matching ADR section. If there is none, add a describe block named after the section.
3. Add the test there. Name it by behaviour. Put the issue number in the test name, not in a file name.
4. Run only that file: node --test tests/<file>. See it fail. Fix the code. See it pass.
5. Do not add a file. If you think the area is missing, add a row to the table and open the ADR first.

## Table

| Group | ADR / PRD | File(s) | Covers | Tests | Baseline s (sum of old files) |
|---|---|---|---|---|---|
| e2e-gp1 | TECH-SPEC GP1, ADR-0019, ADR-0023 | `e2e/cases/GP1-install.e2e.mjs` | GP1 install: node path, docs, install, uninstall, release tree, OpenCode client info (merge 6 GP1 files into one) | 29 | 7.6 |
| e2e-gp3 | TECH-SPEC GP3, ADR-0008 | `e2e/cases/GP3-hooks.e2e.mjs` | GP3 hooks: perf, enforcement, Z Code tool names (merge 3 GP3 files into one) | 23 | 2.1 |
| e2e-gp11 | TECH-SPEC GP11, ADR-0010, ADR-0011 | `e2e/cases/GP11-doctor-upgrade.e2e.mjs` | GP11 doctor, upgrade, release audit, Pi and Antigravity (merge 3 GP11 files into one) | 18 | 6.2 |
| e2e-gp-keep | TECH-SPEC GP2, GP4-GP10, GP-SEARCH, GP-SETUP | (stay in place) `e2e/cases/GP2-prompt-surface.e2e.mjs`, `e2e/cases/GP4-execute.e2e.mjs`, `e2e/cases/GP5-index-search.e2e.mjs`, `e2e/cases/GP6-journal-resume.e2e.mjs`, `e2e/cases/GP7-scope.e2e.mjs`, `e2e/cases/GP8-concurrency.e2e.mjs`, `e2e/cases/GP9-lifecycle.e2e.mjs`, `e2e/cases/GP10-stats.e2e.mjs`, `e2e/cases/GP-SEARCH-heldout.e2e.mjs`, `e2e/cases/GP-SETUP-npm-install.e2e.mjs` | one file per GP case already; stay in place | 118 | 253.0 |
| 0003-e2e-harness | ADR-0003 | (stay in place) `e2e/harness/normalize.test.mjs`, `e2e/harness/run-filter.test.mjs` | tests of the e2e harness itself (stay in place under e2e/, never import src/) | 15 | 0.2 |
| 0012-live-eval-selftests | ADR-0012 | (stay in place) `e2e/live/cache/analyze.test.mjs`, `e2e/live/compact-hard/score.test.mjs`, `e2e/live/routing/score.test.mjs` | scorers and analyzers of the live evals (stay in place; compact-hard is frozen) | 35 | 0.3 |
| 0012-live-harness | ADR-0012 | `tests/0012-live-harness.test.mjs` | keyless live harness, process groups, compact eval arms, M2 bench scorer | 40 | 2.5 |
| 0012-m2-bench | ADR-0012 | `tests/0012-m2-bench.test.mjs` | M2 bench fixtures runner and the bench suite result checks (builds the bundle with a blocking execFileSync; own file so it cannot stall the timer tests) | 4 | 4.4 |
| 0017-v1-retention | ADR-0017 | `tests/0017-v1-retention.test.mjs` | v1 vs v2 diff and the ported v1 executor and store tests | 37 | 20.4 |
| 0018-contracts | ADR-0018 | `tests/0018-contracts.test.mjs` | module contracts and single-source hook file | 46 | 0.3 |
| 0018-build | ADR-0018, ADR-0019, ADR-0023 | `tests/0018-build.test.mjs` | build, generated files, host manifests, npm package | 79 | 10.1 |
| 0002-store | ADR-0002, PRD-v2 section 4, GP8, GP9 | `tests/0002-store.test.mjs` | single DB, schema, cleanup, checkpoint, owners, lifecycle exit, HTTP fail-open and legacy import fallback | 79 | 8.5 |
| 0007-identity | ADR-0007, PRD-v2 section 5, GP7 | `tests/0007-identity.test.mjs` | project and session identity, scope, containment, per-host home dirs | 86 | 6.4 |
| 0007-mcp-server | ADR-0004, ADR-0005, ADR-0007, PRD-v2 sections 6-7 | `tests/0007-mcp-server.test.mjs` | MCP server, tool registry, call shapes, prompt delivery | 65 | 4.4 |
| prd8-index-search | PRD-v2 section 8, GP5 | `tests/prd8-index-search.test.mjs` | chunking, index, FTS search, fetch, snippets | 201 | 8.3 |
| prd9-sandbox | PRD-v2 section 9, GP4 | `tests/prd9-sandbox.test.mjs` | execute, batch, runtimes, env, cap, kill, spawn | 91 | 11.3 |
| prd12-stats-purge | PRD-v2 sections 8 and 12, GP10 | `tests/prd12-stats-purge.test.mjs` | stats and purge tools | 21 | 5.8 |
| 0008-enforcement | ADR-0001, ADR-0008, PRD-v2 section 10, GP3 | `tests/0008-enforcement.test.mjs` | policy: lexer, parse, decide, deny rules, unwrap, external MCP | 176 | 1.4 |
| 0016-subagent | ADR-0016 | `tests/0016-subagent.test.mjs` | subagent context protection, run wrapper, VS Code tools | 56 | 1.9 |
| prd10-hooks-runtime | PRD-v2 section 10, GP3, GP6, GP7 | `tests/prd10-hooks-runtime.test.mjs` | hook process: stdin, entry, dispatch, saving, errors, throttle | 280 | 23.0 |
| prd10-hook-fuzz | PRD-v2 section 10 | `tests/prd10-hook-fuzz.test.mjs` | seeded hook fuzz on every host (the long pole; one file on purpose) | 22 | 51.1 |
| 0009-compaction-memory | ADR-0009, PRD-v2 section 11, GP6 | `tests/0009-compaction-memory.test.mjs` | compaction, journal, resume, recall, search decision | 79 | 3.7 |
| 0020-adapters | ADR-0020, PRD-v2 section 3 | `tests/0020-adapters.test.mjs` | agent adapters and the host table | 182 | 2.8 |
| 0020-plugins | ADR-0020, PRD-v2 section 3 | `tests/0020-plugins.test.mjs` | OpenCode and Pi in-process plugins | 33 | 2.0 |
| 0020-hooks-all | ADR-0020 | `tests/0020-hooks-all.test.mjs` | hooks and skills on every agent: one fire matrix | 26 | 27.8 |
| 0020-gates-zcode | ADR-0020 | `tests/0020-gates-zcode.test.mjs` | hook gate and shape for Z Code | 23 | 24.2 |
| 0020-gates-vscode-gemini-kiro | ADR-0020 | `tests/0020-gates-vscode-gemini-kiro.test.mjs` | hook gates for VS Code, Gemini CLI, Kiro | 23 | 24.1 |
| 0020-gates-pi-copilot-claude | ADR-0020 | `tests/0020-gates-pi-copilot-claude.test.mjs` | hook gates for Pi, Copilot CLI, Claude Code, Codex, OpenCode | 40 | 26.0 |
| 0020-fire-hook-config | ADR-0020 | `tests/0020-fire-hook-config.test.mjs` | real-agent fire tests: Claude Code, Codex, Copilot CLI, Gemini CLI, Kiro (skipped when the agent is absent) | 13 | 3.2 |
| 0020-fire-plugin-ext | ADR-0020 | `tests/0020-fire-plugin-ext.test.mjs` | real-agent fire tests: OpenCode, Pi, Qwen, VS Code, Z Code (split from 0020-fire: spawnSync probes block the event loop, so one file ran slower than its longest source) | 12 | 4.0 |
| 0019-setup-engine | ADR-0019, ADR-0023, PRD-setup | `tests/0019-setup-engine.test.mjs` | interactive setup engine and its no-regex rule | 73 | 34.5 |
| 0019-host-config | ADR-0019, ADR-0023, PRD-setup | `tests/0019-host-config.test.mjs` | host config read/write, TOML, plugin root and swap, uninstall | 121 | 1.8 |
| 0019-cli | ADR-0019, PRD-setup | `tests/0019-cli.test.mjs` | the context-mode CLI | 59 | 35.6 |
| 0010-doctor-upgrade | ADR-0010, PRD-v2 section 13, GP11 | `tests/0010-doctor-upgrade.test.mjs` | doctor, upgrade, release fetch, checksums, report | 124 | 12.9 |
| 0011-v1-transition | ADR-0011, GP11 | `tests/0011-v1-transition.test.mjs` | v1 detect and remove, v1 migration | 44 | 1.7 |
| 0013-release-main | ADR-0013, PRD-v2 section 14 | `tests/0013-release-main.test.mjs` | release to main: publish, plan-main, commit, branch protection | 43 | 22.0 |
| 0013-release-plan | ADR-0013, ADR-0019, PRD-v2 section 14 | `tests/0013-release-plan.test.mjs` | release plan, smoke, rollback, npm publish, who gets this | 69 | 23.6 |
| 0014-repo-hygiene | ADR-0013, ADR-0014, ADR-0015 | `tests/0014-repo-hygiene.test.mjs` | issue forms, workflows, README, secrets, removed files | 80 | 3.6 |
| 0023-install-docs | ADR-0023, PRD-setup | `tests/0023-install-docs.test.mjs` | install docs per agent use the native install command | 44 | 0.8 |
| 0021-cache-safety | ADR-0021 | `tests/0021-cache-safety.test.mjs` | prompt cache safety, prefix determinism, cache usage | 37 | 9.5 |

Groups marked "stay in place" are already one file per area; the move does not touch them. The other groups merge their source files into the one target file. 252 existing files move; the sources of every group are in review/test-layout/groups.json.

## Numbers behind the table

Before: 242 unit files, 2624 test names, suite wall median 102 s (same machine, same load, 3 interleaved runs). After: 34 unit files, 2624 names, 100 s. See review/test-layout/BASELINE.md and ADR-0024 (Result).

## Guard

tests/0014-repo-hygiene.test.mjs (section ADR-0024) fails for every *.test.mjs under tests and every case file under e2e/cases that this table does not list by path. The e2e files that stay in place are listed by path in the e2e-gp-keep row.

ADR-0002 store coverage also checks HTTP tenant/project isolation, native hook forwarding and fail-open transport errors, legacy import identity fallback and ownership overrides, and the flat bundled server deployment layout.

## Bounded unit suite and real-host e2e (T225)

`npm test` runs `scripts/test-suite.mjs`. It builds generated source, takes the
T202-compatible workstation lock (`crew-runtime-tests.lock` in the temp directory),
and runs every unit test file with the spec reporter, one file at a time. The
lock uses `{pid, startedAt, cwd}`, exclusive creation, live-owner waiting, stale
owner reclamation and owner-checked release. Limits and lock rules are data in
`scripts/test-suite.json`; `--timeout-ms` overrides only the per-file watchdog.
The M2 benchmark's own 60-second assertion and production hook deadlines remain
unchanged. A watchdog reports the file and last completed test, terminates the
owned process tree, and continues. Missing summaries and nonzero exits fail the
run. The final `FULL SUITE` line aggregates the same run's native file summaries;
`fileFailures` and `timeouts` separately identify incomplete files. Interrupted
runs print `FULL SUITE PARTIAL`. `TEST_LOCK_DIR` and `TEST_LOCK_WAIT_SECONDS` use
T202's meanings.

`0020-fire-hook-config.test.mjs` and `0020-fire-plugin-ext.test.mjs` probe real
installed clients, even though their providers and homes are temporary. They are
opt-in e2e suites, named as skipped with the reason in the unit output. Set
`CM_REAL_HOST_E2E=1` and use `node scripts/test-suite.mjs --file
0020-fire-hook-config.test.mjs` (or the plugin/ext file) to run them. When enabled,
the existing per-client checks still name a missing binary and its skip reason.
The aggregate separately reports `e2eSuitesSkipped`, since Node's native leaf-test
skip counter does not count a skipped describe that registers no children.

The unit gates retain the synthetic Copilot command/framed-JSON fixture, including
missing MCP registration, disabled hooks and re-enablement. A persistent stub
server verifies discovery closes stdout and kills a Windows shim's descendant.
The Kiro loader-event fixture shares its parser with the real e2e check; it checks
registered/read counts and rejects missing or malformed acknowledgements. Kiro
configuration/enabled-entry tests remain deterministic unit fixtures. These tests
exercise the contracts without installing a client or using a machine home.

The watchdog's process cleanup is separately bounded by cleanupTimeoutSeconds in the policy file. The runner prints its own PID before lock acquisition, and handled interrupts cancel lock waiting without releasing another process's lock. Discovery fixtures include notifications and unrelated response IDs before the requested response.

The watchdog's synthetic open-port regression awaits the listening event before completing its test. Its artificial per-file budget is thirty seconds: five seconds expired during nested Node startup on a busy Windows machine before the fixture ran. The regression still requires the named test, one watchdog timeout, the next file's success, release of the owned port, and release of its isolated lock. This fixture allowance does not change the suite policy or production deadlines.

The release fixture files yield to the event loop before each case. Their synchronous local Git/Node subprocesses previously prevented spec progress from flushing until the file ended, making active work look stalled. On this Windows host one representative fixture passed in 75 seconds (43 seconds with empty Git config); the complete release-main file was still advancing through fixture children when the initial fifteen-minute whole-file watchdog expired. The default whole-file watchdog is therefore one hour. This bounds an entire fixture file; it changes neither assertions nor individual test/benchmark deadlines. Git configuration is unchanged because the comparison did not establish a configuration defect.

The local T202 lock port writes startedAt after atomic acquisition. Its former pre-wait timestamp counted queue time against ownership and let a challenger reclaim a live suite before its full hold budget. A deterministic isolated-lock regression waits 600 ms, holds for 500 ms under a one-second budget, and requires a challenger to leave that owner intact. The shared record format and stale-owner policy are unchanged; no other checkout's lock implementation is modified.

The ten-host fuzz matrix retains 500 cases per host and creates a fresh hook process for each call. A single host took 382 seconds on Windows; the complete serial matrix has a separate ninety-minute whole-file watchdog in fileTimeoutSecondsByFile. HOOK_TIMEOUT_MS for each call, the M2 sixty-second assertion, every fixed seed and the one-child Windows pool are unchanged. Per-file policy keys use forward slashes for nested paths; an explicit --timeout-ms overrides them.

A long Windows suite can outlast the shared T202 two-hour maximum hold time. Before each file, the runner reserves that file's hard budget, process cleanup and leaseReserveMs. When the reservation would cross maxHoldMs, it releases the lock only after the previous file has exited, yields for one poll interval and reacquires before launching another child. maxFilesPerLease (zero by default) can request an earlier handoff. No tests execute while the lock is released or being reacquired. The shared pid/startedAt/cwd record and stale-owner limits are unchanged; legacy pre-wait timestamps are interpreted with the lock file's acquisition mtime. Isolated regressions check fresh legacy holders, expiration, actual handoff timestamps, ordering and nested per-file budgets.

Zcode invalid-setting cases render their initial configuration and skills from buildRegistry, configEdits, the hook shape and renderSkill through the shared config editor. The former helper ignored runSetup's result, so an unrelated verification failure rolled back config.json and the locale test threw ENOENT before validation. A controlled MCP-server exit reproduces that failure. Schema cases now reach the same doctor assertions without a preparatory runtime probe; the clean-setup integration case still runs full setup and checks its exit code. No production verification deadline changed.

### T225 focused attribution (Windows, checked 2026-11-09)

A detached origin/main worktree at 3a3ef7d53c9a30ef05d8f1b009afbcf8d9c6d0a2 was built once under F:/projects-test/context-mode/t225-main-check, outside F:/Projects, then removed. Each selection ran directly with node --test --test-concurrency=1 --test-reporter=spec, from release-out, without the suite runner or machine lock. No other owned test suite ran concurrently.

| Selection | Clean origin/main | Fork code 0c328376 |
| --- | --- | --- |
| Zcode: a clean setup passes doctor; valid user keys and unknown top-level keys keep PASS | 2 tests, 2 pass, 0 fail, exit 0; duration_ms 105046.5331 | 2 tests, 2 pass, 0 fail, exit 0; duration_ms 50300.3782 |
| Claude hook fuzz, CM_FUZZ_N=500, name pattern hook-fuzz claude-code | 2 tests, 1 pass, 1 fail, exit 1; duration_ms 303422.7381; 51 of 500 calls broke invariants | Earlier branch diagnostic: 2 tests, 1 pass, 1 fail, exit 1; 47 of 500 calls broke invariants |

The Claude deadline/invariant failure reproduces on clean upstream main. It remains a pre-existing performance issue for separate follow-up; T225 does not change its assertions, case count, seeds, or production deadline. The baseline retained main's six-child pool; the fork retains its one-child Windows pool, so counts and durations are attribution evidence, not a performance comparison. A 900-second outer watchdog was armed; baseline finished naturally in 303 seconds.

Get-Process node snapshots were saved before both baseline selections and during the fuzz run. Six nodes preceded baseline Zcode, seven preceded baseline Claude, and seven preceded the fork Zcode rerun; each before-run two-second sample showed zero CPU growth for those processes. The during-Claude sample contained fifteen nodes, including the baseline runner and its own pool. No competing owned suite was present. These samples describe Node activity; they do not prove absence of disk or scheduler contention.

The earlier Zcode diagnostic failed with hook exited null, emitted by src/setup/engine.ts after its unchanged bounded spawnSync probe. Both baseline and the current fork pass the two cases in exclusive runs. Therefore this evidence does not classify the Zcode failures as pre-existing, and no Zcode runtime fix is claimed. The prior branch-only timing failure is not reproduced on current code; future recurrence needs the child error/signal and concurrent-process record, rather than a raised deadline or another blind retry. The engine verification path and the generated fake hook are unchanged from origin/main.
