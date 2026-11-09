#!/usr/bin/env node
// Full unit suite: one bounded file at a time, with the T202 workstation lock.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, LockWaitTimeout } from "./test-lock.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.lastIndexOf(name); if (at < 0) return fallback; if (!args[at + 1]) throw new Error(`missing value for ${name}`); return args[at + 1]; };
const policy = JSON.parse(readFileSync(option("--config", fileURLToPath(new URL("./test-suite.json", import.meta.url))), "utf8"));
if (!Array.isArray(policy.nodeArgs) || !policy.nodeArgs.every((arg) => typeof arg === "string") || typeof policy.testSuffix !== "string" || !policy.testSuffix) throw new Error("invalid test-suite policy");
if (typeof policy.lock?.fileName !== "string" || !policy.lock.fileName || path.basename(policy.lock.fileName) !== policy.lock.fileName) throw new Error("lock fileName must be a basename");
for (const [key, value] of Object.entries(policy.lock)) if (key !== "fileName" && (!Number.isFinite(value) || value < 0)) throw new Error(`invalid lock policy ${key}`);
const testsDir = path.resolve(option("--tests-dir", path.join(root, "tests")));
const fileTimeout = Number(option("--timeout-ms", policy.fileTimeoutSeconds * 1000));
if (!Number.isFinite(fileTimeout) || fileTimeout <= 0) throw new Error("file timeout must be positive");
const totals = { files: 0, tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, e2eSuitesSkipped: 0, fileFailures: 0, timeouts: 0 };
let expectedFiles = 0;
let interrupted = false;
let stopChild;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; stopChild?.(); });

function kill(child) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true, timeout: policy.cleanupTimeoutSeconds * 1000 });
    if (result.error || result.status !== 0) child.kill("SIGKILL");
  }
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
  }
  child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
}

function run(file, commandArgs, cwd, budget) {
  console.log(`FILE START ${file}`);
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: "0" };
    delete env.NODE_TEST_CONTEXT; // A fixture runner is a new test run, not a recursive node:test worker.
    const child = spawn(process.execPath, commandArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let output = "", last = "no completed test yet", settled = false;
    const finish = (code, timeout = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stopChild = undefined;
      console.log(`FILE END ${file} exit=${code}${timeout ? ` TIMEOUT last=${last}` : ""}`);
      resolve({ code, timeout, output });
    };
    const consume = (chunk) => {
      const text = chunk.toString(); output += text; process.stdout.write(text);
      const lines = text.split(/\r?\n/).filter((line) => /[✔✖▶]/u.test(line));
      if (lines.length) last = lines.at(-1).trim().slice(0, 300);
    };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    const timer = setTimeout(() => { kill(child); finish(124, true); }, budget);
    stopChild = () => { kill(child); finish(130); };
    child.once("error", (error) => { console.error(error.message); finish(1); });
    child.once("close", (code) => finish(code ?? 1));
  });
}

function counts(text) {
  const out = {};
  for (const match of text.matchAll(/(?:^|\n)[ℹ#]\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)/gu)) out[match[1]] = Number(match[2]);
  return out;
}

let lock;
let exitCode = 0;
const began = Date.now();
try {
  const rules = { ...policy.lock };
  if (process.env.TEST_LOCK_WAIT_SECONDS) rules.maxWaitMs = Number(process.env.TEST_LOCK_WAIT_SECONDS) * 1000;
  console.log(`FULL SUITE QUEUE pid=${process.pid} cwd=${process.cwd()}`);
  lock = await acquireLock({ dir: option("--lock-dir", process.env.TEST_LOCK_DIR || tmpdir()), rules, cwd: process.cwd(), log: console.log,
    sleep: async (ms) => { if (interrupted) throw new Error("suite interrupted while waiting for lock"); await new Promise((resolve) => setTimeout(resolve, ms)); if (interrupted) throw new Error("suite interrupted while waiting for lock"); } });
  if (interrupted) throw new Error("suite interrupted before test files started");
  const files = [];
  const visit = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !policy.ignoredDirectories.includes(entry.name)) visit(path.join(dir, entry.name));
    else if (entry.isFile() && entry.name.endsWith(policy.testSuffix)) files.push(path.relative(testsDir, path.join(dir, entry.name)));
  } };
  visit(testsDir); files.sort();
  const selected = option("--file", "");
  if (selected) { const keep = files.filter((name) => name === selected); files.splice(0, files.length, ...keep); }
  expectedFiles = files.length;
  if (!files.length) throw new Error(`no test files in ${testsDir}`);
  console.log(`FULL SUITE START files=${files.length} fileTimeoutMs=${fileTimeout} lock=${lock.path}`);
  if (!args.includes("--no-build")) {
    const build = await run("generated-source", [path.join(root, "build/build.mjs"), "--generated-only"], root, fileTimeout);
    if (build.code !== 0) throw new Error(`generated source failed: ${build.code}`);
  }
  for (const name of files) {
    if (interrupted) break;
    const result = await run(name, [...policy.nodeArgs, path.join(testsDir, name)], process.cwd(), fileTimeout);
    const c = counts(result.output);
    totals.files++;
    totals.e2eSuitesSkipped += [...result.output.matchAll(/# e2e: requires installed agent clients/gu)].length;
    for (const key of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) totals[key] += c[key] ?? 0;
    if (result.timeout) totals.timeouts++;
    if (result.code !== 0 || c.tests === undefined || c.fail > 0 || c.cancelled > 0) totals.fileFailures++;
  }
  exitCode = interrupted ? 130 : totals.fileFailures ? 1 : 0;
} catch (error) {
  console.error(error.message);
  exitCode = interrupted ? 130 : error instanceof LockWaitTimeout ? 75 : 1;
} finally {
  stopChild?.(); lock?.release();
  const label = interrupted || !lock || !expectedFiles || totals.files !== expectedFiles || totals.timeouts ? "FULL SUITE PARTIAL" : "FULL SUITE";
  for (const key of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) console.log(`# ${key} ${totals[key]}`);
  console.log(`${label}: ${Object.entries(totals).map(([key, value]) => `${key}=${value}`).join(" ")} durationMs=${Date.now() - began} exit=${exitCode}`);
}
process.exitCode = exitCode;
