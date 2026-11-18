// Named regression cases found by tests/prd10-hook-fuzz.test.mjs. Each entry is a minimised crash.
// { name, hosts: "all" | [host...], stdin: string | (host, dirs) => string, noHome?: true, holdLock?: true }
// holdLock: the runner first creates the project DB with one SessionStart call, then holds BEGIN IMMEDIATE on it from a
// second connection for the whole call (another hook or server mid-write).
const claude = (payload) => (host, dirs) => JSON.stringify({ session_id: "s1", cwd: dirs.repoDir, ...payload });

export const REGRESSIONS = [
  // T271 (D-HOOK-BUSY-1): seeded fuzz runs on Windows timed out on invariant 4 (the call ends inside HOOK_TIMEOUT_MS).
  // A hook that met a held write lock waited DB_TIMEOUT_MS (5000, equal to HOOK_TIMEOUT_MS) per connection: SessionStart
  // and UserPromptSubmit took 5.2-5.7 s, PostToolUse 10.4 s (store wait plus the detached journal wait).
  { name: "T271 SessionStart under a held write lock", hosts: ["claude-code"], holdLock: true, stdin: claude({ hook_event_name: "SessionStart", source: "startup" }) },
  { name: "T271 SessionStart compact under a held write lock", hosts: ["claude-code"], holdLock: true, stdin: claude({ hook_event_name: "SessionStart", source: "compact" }) },
  { name: "T271 UserPromptSubmit under a held write lock", hosts: ["claude-code"], holdLock: true, stdin: claude({ hook_event_name: "UserPromptSubmit", prompt: "hello" }) },
  { name: "T271 PostToolUse under a held write lock", hosts: ["claude-code"], holdLock: true, stdin: claude({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x".repeat(5000) } }) },
];
