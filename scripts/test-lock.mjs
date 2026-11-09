// T202 lock protocol, ported from AgentEcosystem/runtime/ts/src/testLock.ts.
// Local lease handling keeps the same shared record and stale-owner policy.
import { closeSync, copyFileSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
class LockWaitTimeout extends Error {
  constructor(holder, waitedMs, message) {
    super(message);
    this.holder = holder;
    this.waitedMs = waitedMs;
    this.name = "LockWaitTimeout";
  }
}
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function describeHolder(holder, now) {
  const started = Date.parse(holder.startedAt);
  const age = Number.isFinite(started) ? `${duration(now - started)} ago` : "start time unknown";
  return `pid ${holder.pid} (started ${holder.startedAt}, ${age}, in ${holder.cwd})`;
}
function parseHolder(text) {
  try {
    const value = JSON.parse(text);
    if (typeof value.pid === "number" && typeof value.startedAt === "string") {
      return { pid: value.pid, startedAt: value.startedAt, cwd: String(value.cwd ?? "") };
    }
  } catch {
  }
  return void 0;
}
function readRaw(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
}
function acquiredSince(holder, modified) {
  // Older writers stamp queue entry. The lock file is written on acquisition.
  const claimed = Date.parse(holder.startedAt);
  return Number.isFinite(claimed) ? Math.max(claimed, modified) : modified;
}
async function acquireLock(options) {
  const { rules } = options;
  const path = join(options.dir, rules.fileName);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const isAlive = options.isAlive ?? pidIsAlive;
  const log = options.log ?? (() => void 0);
  const mine = { pid, startedAt: new Date(now()).toISOString(), cwd: options.cwd ?? process.cwd() };
  const began = now();
  let lastAnnounce = Number.NEGATIVE_INFINITY;
  let announcedFor = "";
  for (; ; ) {
    try {
      const fd = openSync(path, "wx");
      try {
        // The shared protocol uses startedAt to bound ownership, not queue age.
        mine.startedAt = new Date(now()).toISOString();
        writeSync(fd, JSON.stringify(mine));
      } finally {
        closeSync(fd);
      }
      const waitedMs = now() - began;
      if (waitedMs > 0 && announcedFor !== "") log(`test lock ${path} taken after waiting ${duration(waitedMs)}`);
      return { path, waitedMs, acquiredAtMs: Date.parse(mine.startedAt), release: () => releaseLock(path, pid) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const raw = readRaw(path);
    if (raw === void 0) continue;
    const holder = parseHolder(raw);
    const modified = (() => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return now();
      }
    })();
    let staleReason = "";
    if (holder === void 0) {
      if (now() - modified > rules.partialFileMs) staleReason = "the lock file is not a lock";
    } else if (!isAlive(holder.pid)) {
      staleReason = `holder ${describeHolder(holder, now())} is gone`;
    } else if (acquiredSince(holder, modified) < now() - rules.maxHoldMs) {
      staleReason = `holder ${describeHolder(holder, now())} has held it longer than ${duration(rules.maxHoldMs)}`;
    }
    if (staleReason !== "") {
      if (reclaim(path, raw, pid)) log(`test lock reclaimed: ${staleReason}`);
      continue;
    }
    const waited = now() - began;
    if (waited >= rules.maxWaitMs) {
      const who = holder ? describeHolder(holder, now()) : "an unreadable lock file";
      throw new LockWaitTimeout(holder, waited, `gave up after ${duration(waited)} waiting for the test lock held by ${who}`);
    }
    const key = holder ? String(holder.pid) : "unreadable";
    if (key !== announcedFor || now() - lastAnnounce >= rules.announceMs) {
      const who = holder ? describeHolder(holder, now()) : "a run that is still writing it";
      log(`waiting for the full-suite test lock ${path}, held by ${who}; checking every ${duration(rules.pollMs)}, giving up after ${duration(rules.maxWaitMs)}`);
      lastAnnounce = now();
      announcedFor = key;
    }
    await sleep(rules.pollMs);
  }
}
function reclaim(path, judged, pid) {
  const aside = `${path}.stale-${pid}`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  if (readRaw(aside) === judged) {
    try {
      unlinkSync(aside);
    } catch {
    }
    return true;
  }
  try {
    copyFileSync(
      aside,
      path,
      1
      /* COPYFILE_EXCL */
    );
  } catch {
  }
  try {
    unlinkSync(aside);
  } catch {
  }
  return false;
}
function releaseLock(path, pid) {
  const holder = parseHolder(readRaw(path) ?? "");
  if (holder === void 0 || holder.pid !== pid) return;
  try {
    unlinkSync(path);
  } catch {
  }
}
export function leaseNeedsRotation({ heldMs, completedFiles, fileBudgetMs, cleanupBudgetMs, rules }) {
  const fileLimit = rules.maxFilesPerLease ?? 0;
  return (fileLimit > 0 && completedFiles >= fileLimit) ||
    heldMs + fileBudgetMs + cleanupBudgetMs + (rules.leaseReserveMs ?? 0) >= rules.maxHoldMs;
}

export {
  LockWaitTimeout,
  acquireLock,
  describeHolder,
  pidIsAlive
};
