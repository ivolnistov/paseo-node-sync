import { open, rename, mkdir, readFile, unlink, link } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";

async function fsyncDir(dir: string) {
  const h = await open(dir, "r");
  try { await h.sync(); } finally { await h.close(); }
}

// Temp file in the same directory, fsync, rename, fsync the directory: readers see old or new, never partial.
export async function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${dir}/.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const h = await open(tmp, "wx", mode);
  try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
  try { await rename(tmp, path); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  await fsyncDir(dir);
}

// ---- Cross-process lock for local daemon-owned state --------------------------------------------------
//
// Contract and correctness argument (macOS and Linux, local filesystem, one host):
// 1. Creation is atomic and never empty: the record {pid, host, token} is written and fsynced to a temp file,
//    then link()ed to the lock path. link fails with EEXIST if the path exists, so exactly one creator wins,
//    and nobody can ever observe a lock file without its record.
// 2. A lock file with token T is removed only (a) by T's owner on release, after checking that the file
//    still carries T, or (b) by a reclaimer that holds "<lock>.reclaim" and has re-read under it that the file
//    still carries T and that T's owner is provably dead (same host, kill(pid, 0) == ESRCH, or our own pid
//    with a token this process does not hold). Every token, lock or guard, enters heldTokens before its record
//    can be published and leaves only after its release completed, so "own pid, unknown token" can only be a
//    record left by an earlier process that had the same pid. Tokens are random, so "carries T" pins one lock instance even
//    when the pathname is reused.
// 3. While a reclaimer holds .reclaim, the file carrying T cannot change: its dead owner cannot release it and
//    every other reclaimer needs .reclaim. So the unlink in (b) removes exactly the stale instance; a waiter
//    whose stale observation is older finds the successor's token under .reclaim and leaves it alone.
// 4. Nothing is reclaimed on doubt: an unreadable record, another host, or a pid that exists (possibly
//    recycled) keeps the lock. Waiters give up at their deadline with "lock busy (<reason>)", no takeover.
// 5. .reclaim itself is never reclaimed automatically. A reclaimer that dies inside its microsecond window
//    leaves it behind, and every later reclaim then fails closed until an operator removes it.
// Residual limits: a lock removed by hand while its owner is alive breaks rule 2 for that instance. Hosts
// sharing one filesystem across pid namespaces with equal hostnames could misjudge liveness.

export interface LockRecord { pid: number; host: string; token: string; at: number }
// Test-only interleaving points; production callers never pass them.
export interface LockHooks { afterPublish?: (path: string) => Promise<void>; afterStaleJudged?: () => Promise<void>; beforeReclaimUnlink?: () => Promise<void>; onWait?: (reason: string) => Promise<void> | void }

// Tokens of lock instances this process may have published and not yet finished releasing. A token is added
// before its record can appear on disk and removed only after its release completed, so a record carrying our
// pid and a token missing from this set really belongs to an earlier, dead process that had the same pid.
const heldTokens = new Set<string>();
export function heldTokenCountForTests(): number { return heldTokens.size; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

// The caller must have registered record.token in heldTokens before calling: link() publishes the record.
async function createExclusive(path: string, record: LockRecord, hooks?: LockHooks): Promise<boolean> {
  const tmp = `${path}.${record.token}.tmp`;
  const h = await open(tmp, "wx", 0o600);
  try { await h.writeFile(JSON.stringify(record)); await h.sync(); } finally { await h.close(); }
  let published = false;
  try { await link(tmp, path); published = true; }
  catch (e) { if (code(e) !== "EEXIST") { await unlink(tmp).catch(() => {}); throw e; } }
  // A leftover temp file is harmless litter; failing here after a successful link would orphan a live lock.
  await unlink(tmp).catch(() => {});
  if (published) await hooks?.afterPublish?.(path);
  return published;
}

async function readRecord(path: string): Promise<LockRecord | "gone" | "unreadable"> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (e) { if (code(e) === "ENOENT") return "gone"; throw e; }
  try {
    const r = JSON.parse(text) as Partial<LockRecord>;
    return typeof r.pid === "number" && typeof r.host === "string" && typeof r.token === "string" ? r as LockRecord : "unreadable";
  } catch { return "unreadable"; }
}

function ownerState(r: LockRecord): "alive" | "dead" | "unverifiable" {
  if (r.host !== hostname()) return "unverifiable";
  if (r.pid === process.pid) return heldTokens.has(r.token) ? "alive" : "dead";
  try { process.kill(r.pid, 0); return "alive"; } catch (e) { return code(e) === "ESRCH" ? "dead" : "alive"; }
}

async function unlinkIfToken(path: string, token: string): Promise<boolean> {
  const r = await readRecord(path);
  if (r === "gone" || r === "unreadable" || r.token !== token) return false;
  try { await unlink(path); return true; } catch (e) { if (code(e) === "ENOENT") return false; throw e; }
}

// Returns null when the stale instance was removed (or already gone), otherwise why it was not.
async function reclaim(lockPath: string, staleToken: string, mine: LockRecord, hooks?: LockHooks): Promise<string | null> {
  const guard = `${lockPath}.reclaim`;
  const guardRecord = { ...mine, token: randomBytes(16).toString("hex") };
  heldTokens.add(guardRecord.token);
  let created: boolean;
  try { created = await createExclusive(guard, guardRecord, hooks); }
  catch (e) { await unlinkIfToken(guard, guardRecord.token); heldTokens.delete(guardRecord.token); throw e; }
  if (!created) {
    heldTokens.delete(guardRecord.token);
    const g = await readRecord(guard);
    return g !== "gone" && g !== "unreadable" && ownerState(g) === "dead"
      ? `reclaim guard ${guard} left by dead pid ${g.pid}; remove it by hand after checking`
      : "another reclaim in progress";
  }
  try {
    const current = await readRecord(lockPath);
    if (current === "gone") return null;
    if (current === "unreadable" || current.token !== staleToken || ownerState(current) !== "dead") return "holder changed or alive";
    await hooks?.beforeReclaimUnlink?.();
    await unlink(lockPath).catch(e => { if (code(e) !== "ENOENT") throw e; });
    return null;
  } finally {
    await unlinkIfToken(guard, guardRecord.token);
    heldTokens.delete(guardRecord.token); // only after the guard file is gone; if unlink threw, stay registered
  }
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, opts: { timeoutMs?: number; hooks?: LockHooks } = {}): Promise<T> {
  const mine: LockRecord = { pid: process.pid, host: hostname(), token: randomBytes(16).toString("hex"), at: Date.now() };
  // Registered before the first await, so no same-process caller can ever see this record as a dead owner's.
  heldTokens.add(mine.token);
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    let reason = "";
    for (let attempt = 0; ; attempt++) {
      if (await createExclusive(lockPath, mine, opts.hooks)) break;
      const holder = await readRecord(lockPath);
      if (holder === "gone") reason = "released during check";
      else if (holder === "unreadable") reason = "unreadable lock record, not reclaimed";
      else {
        const state = ownerState(holder);
        if (state === "dead") {
          await opts.hooks?.afterStaleJudged?.();
          reason = (await reclaim(lockPath, holder.token, mine, opts.hooks)) ?? "";
        }
        else reason = state === "alive" ? `held by live pid ${holder.pid}` : `held by unverifiable owner on ${holder.host}`;
      }
      if (Date.now() >= deadline) throw new Error(`lock busy: ${lockPath} (${reason || "stale lock removed but lost the race to recreate"})`);
      if (reason === "") continue; // stale instance removed; retry creation at once
      await opts.hooks?.onWait?.(reason);
      await sleep(Math.min(20 * 2 ** Math.min(attempt, 4), 250) * (0.5 + Math.random() / 2));
    }
  } catch (e) {
    // Not acquired. Remove our instance if a hook failed after publication, then drop the registration.
    await unlinkIfToken(lockPath, mine.token);
    heldTokens.delete(mine.token);
    throw e;
  }
  try { return await fn(); } finally {
    await unlinkIfToken(lockPath, mine.token);
    heldTokens.delete(mine.token); // only after a completed release; if unlink threw, stay registered (fail closed)
  }
}
