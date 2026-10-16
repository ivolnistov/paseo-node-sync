import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, utimes, chmod, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { withLock } from "../server/fsatomic.ts";

const workerPath = new URL("./lock-worker.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitUntil(cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error("waitUntil timed out"); await sleep(5); }
}
function worker(o: Record<string, unknown>) {
  const child = spawn(process.execPath, [workerPath, JSON.stringify(o)], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  return { child, done: new Promise<string>(r => child.on("close", () => r(out))) };
}
async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ["-e", ""]);
  await new Promise(r => c.on("close", r));
  return c.pid!;
}
const staleRecord = (pid: number) => JSON.stringify({ pid, host: hostname(), token: "0".repeat(32), at: 0 });
async function lockPid(p: string) { try { return (JSON.parse(await readFile(p, "utf8")) as { pid: number }).pid; } catch { return null; } }
function intervals(log: string) {
  const ev = log.trim().split("\n").map(l => l.split(" ")).filter(p => p[1] === "enter" || p[1] === "exit");
  const out: Record<string, { enter: number; exit: number }> = {};
  for (const [name, what, at] of ev) (out[name!] ??= { enter: 0, exit: 0 })[what as "enter" | "exit"] = Number(at);
  return out;
}

test("two reclaimers with a stale observation never overlap, and the late one never deletes the successor", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lockt-`);
  const lock = `${dir}/x.lock`, log = `${dir}/log`;
  await writeFile(lock, staleRecord(await deadPid()));
  // W1 judges the lock stale under the reclaim guard, then pauses right before its unlink.
  const w1 = worker({ lock, log, name: "W1", holdMs: 400, timeoutMs: 10_000, pauseBeforeUnlink: `${dir}/go` });
  await waitUntil(async () => existsSync(log) && (await readFile(log, "utf8")).includes("W1 paused"));
  // W2 now observes the same stale instance and tries to reclaim while W1 sits between judgement and unlink.
  const w2 = worker({ lock, log, name: "W2", holdMs: 100, timeoutMs: 10_000, waitMarker: `${dir}/w2-waited` });
  await waitUntil(() => existsSync(`${dir}/w2-waited`));
  assert.equal(await readFile(`${dir}/w2-waited`, "utf8"), "another reclaim in progress");
  await writeFile(`${dir}/go`, "");
  await waitUntil(async () => (await readFile(log, "utf8")).includes("W1 enter"));
  assert.equal(await lockPid(lock), w1.child.pid, "W1's live lock survives W2's stale observation");
  assert.deepEqual([await w1.done, await w2.done], ["ok", "ok"]);
  const iv = intervals(await readFile(log, "utf8"));
  // Either may win the recreate race once the barrier opens; what must never happen is overlap.
  assert.ok(iv.W2!.enter >= iv.W1!.exit || iv.W1!.enter >= iv.W2!.exit, `critical sections overlap: ${JSON.stringify(iv)}`);
  assert.equal(existsSync(lock), false);
  await rm(dir, { recursive: true });
});

test("a reclaimer whose stale verdict is outdated cannot delete the successor's live lock (W1 reclaims X, takes Y; W2 then acts on X)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lockt-`);
  const lock = `${dir}/x.lock`, log = `${dir}/log`;
  await writeFile(lock, staleRecord(await deadPid()));
  // W2 judges instance X dead, then is held before it touches the reclaim guard.
  const w2 = worker({ lock, log, name: "W2", holdMs: 50, timeoutMs: 10_000, pauseAfterJudged: `${dir}/go2` });
  await waitUntil(async () => existsSync(log) && (await readFile(log, "utf8")).includes("W2 judged"));
  // W1 reclaims X and enters with its own live instance Y.
  const w1 = worker({ lock, log, name: "W1", holdMs: 600, timeoutMs: 10_000 });
  await waitUntil(async () => (await readFile(log, "utf8")).includes("W1 enter"));
  // Release W2 while W1 is inside: W2 now acts on its outdated verdict about X.
  await writeFile(`${dir}/go2`, "");
  await sleep(200);
  assert.equal(await lockPid(lock), w1.child.pid, "W1's live lock must survive W2's outdated reclaim");
  assert.equal((await readFile(log, "utf8")).includes("W2 enter"), false, "W2 must not enter while W1 holds the lock");
  assert.deepEqual([await w1.done, await w2.done], ["ok", "ok"]);
  const iv = intervals(await readFile(log, "utf8"));
  assert.ok(iv.W2!.enter >= iv.W1!.exit, `critical sections overlap: ${JSON.stringify(iv)}`);
  await rm(dir, { recursive: true });
});

test("a live holder is never stolen; an unreadable record is never reclaimed, however old", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lockt-`);
  const lock = `${dir}/x.lock`, log = `${dir}/log`;
  const holder = worker({ lock, log, name: "H", holdMs: 1500, timeoutMs: 5000 });
  await waitUntil(async () => existsSync(log) && (await readFile(log, "utf8")).includes("H enter"));
  const late = worker({ lock, log, name: "W", holdMs: 10, timeoutMs: 400 });
  assert.match(await late.done, /^error: lock busy: .* \(held by live pid \d+\)$/);
  assert.equal(await lockPid(lock), holder.child.pid);
  assert.equal(await holder.done, "ok");
  await writeFile(`${dir}/empty.lock`, "");
  const old = new Date(Date.now() - 3_600_000);
  await utimes(`${dir}/empty.lock`, old, old);
  await assert.rejects(withLock(`${dir}/empty.lock`, async () => "ran", { timeoutMs: 300 }), /unreadable lock record, not reclaimed/);
  assert.equal(existsSync(`${dir}/empty.lock`), true);
  await rm(dir, { recursive: true });
});

test("the timeout holds when reclaim keeps failing; a guard left by a dead reclaimer fails closed; errors are not swallowed", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lockt-`);
  const lock = `${dir}/x.lock`;
  await writeFile(lock, staleRecord(await deadPid()));
  const sleeper = spawn("/bin/sleep", ["30"]);
  await writeFile(`${lock}.reclaim`, JSON.stringify({ pid: sleeper.pid, host: hostname(), token: "1".repeat(32), at: 0 }));
  let t0 = Date.now();
  await assert.rejects(withLock(lock, async () => "ran", { timeoutMs: 300 }), /lock busy: .*\(another reclaim in progress\)/);
  assert.ok(Date.now() - t0 < 1500, `timeout overrun: ${Date.now() - t0} ms`);
  sleeper.kill(); await new Promise(r => sleeper.on("close", r));
  await writeFile(`${lock}.reclaim`, staleRecord(await deadPid()));
  t0 = Date.now();
  await assert.rejects(withLock(lock, async () => "ran", { timeoutMs: 300 }), /reclaim guard .* left by dead pid \d+; remove it by hand/);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(existsSync(lock), true, "stale lock untouched while the guard is ambiguous");
  await unlink(`${lock}.reclaim`);
  await chmod(dir, 0o500);
  try { await assert.rejects(withLock(lock, async () => "ran", { timeoutMs: 2000 }), (e: NodeJS.ErrnoException) => e.code === "EACCES"); }
  finally { await chmod(dir, 0o700); }
  await rm(dir, { recursive: true });
});

test("a holder killed inside its critical section is recovered; release never removes a successor's lock", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lockt-`);
  const lock = `${dir}/x.lock`, log = `${dir}/log`;
  const crashed = worker({ lock, log, name: "C", holdMs: 0, timeoutMs: 5000, crashMarker: `${dir}/inside` });
  await waitUntil(() => existsSync(`${dir}/inside`));
  crashed.child.kill("SIGKILL"); await crashed.done;
  assert.equal(await worker({ lock, log, name: "R", holdMs: 10, timeoutMs: 5000 }).done, "ok", "dead holder's lock reclaimed");
  // Simulate an external deletion of a live lock: the owner's release must leave the successor's lock alone.
  let successor: ReturnType<typeof worker> | null = null;
  await withLock(lock, async () => {
    await unlink(lock);
    successor = worker({ lock, log, name: "S", holdMs: 800, timeoutMs: 5000 });
    await waitUntil(async () => (await readFile(log, "utf8")).includes("S enter"));
  });
  assert.equal(await lockPid(lock), successor!.child.pid, "successor lock still in place after the earlier owner released");
  assert.equal(await successor!.done, "ok");
  assert.equal((await stat(dir)).isDirectory(), true);
  await rm(dir, { recursive: true });
});
