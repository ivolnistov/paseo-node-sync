import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { withLock, heldTokenCountForTests } from "../server/fsatomic.ts";

function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function deadPid(): Promise<number> { const c = spawn(process.execPath, ["-e", ""]); await new Promise(r => c.on("close", r)); return c.pid!; }
const record = async (p: string) => JSON.parse(await readFile(p, "utf8")) as { pid: number; token: string };

// The seam: A's record is on disk (link done) and A is held right there, before it would have registered its
// token under the old code. B, in the same process, must see a live owner, wait, and never enter.
test("same-process caller held right after publishing is a live owner: the other caller waits and never overlaps", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lsp-`);
  const lock = `${dir}/x.lock`, log: string[] = [], reasons: string[] = [];
  const published = deferred(), gate = deferred(), waited = deferred();
  const a = withLock(lock, async () => { log.push("A enter"); await new Promise(r => setTimeout(r, 50)); log.push("A exit"); },
    { hooks: { afterPublish: async p => { if (p === lock) { published.resolve(); await gate.promise; } } } });
  await published.promise;
  const aToken = (await record(lock)).token;
  const b = withLock(lock, async () => { log.push("B enter"); log.push("B exit"); },
    { timeoutMs: 5000, hooks: { onWait: r => { reasons.push(r); waited.resolve(); } } });
  await waited.promise;
  await new Promise(r => setTimeout(r, 100)); // let B retry a few times while A stays held
  assert.match(reasons[0]!, new RegExp(`^held by live pid ${process.pid}$`));
  assert.ok(reasons.every(r => r.startsWith("held by live pid")), reasons.join("; "));
  assert.equal((await record(lock)).token, aToken, "A's published lock survives");
  assert.deepEqual(log, []);
  gate.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(log, ["A enter", "A exit", "B enter", "B exit"]);
  assert.equal(existsSync(lock), false);
  await rm(dir, { recursive: true });
});

test("same-process reclaimer held right after publishing the reclaim guard is seen as live, not as a dead guard", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lsp-`);
  const lock = `${dir}/x.lock`, guard = `${lock}.reclaim`, reasons: string[] = [], log: string[] = [];
  await writeFile(lock, JSON.stringify({ pid: await deadPid(), host: hostname(), token: "0".repeat(32), at: 0 }));
  const guardUp = deferred(), gate = deferred(), waited = deferred();
  const a = withLock(lock, async () => { log.push("A enter"); log.push("A exit"); },
    { hooks: { afterPublish: async p => { if (p === guard) { guardUp.resolve(); await gate.promise; } } } });
  await guardUp.promise;
  const b = withLock(lock, async () => { log.push("B enter"); log.push("B exit"); },
    { timeoutMs: 5000, hooks: { onWait: r => { reasons.push(r); waited.resolve(); } } });
  await waited.promise;
  assert.equal(reasons[0], "another reclaim in progress");
  assert.equal(existsSync(guard), true);
  gate.resolve();
  await Promise.all([a, b]);
  assert.ok(reasons.every(r => !r.includes("left by dead pid")), reasons.join("; "));
  assert.equal(log.length, 4);
  assert.ok(log.indexOf("B enter") > log.indexOf("A exit") || log.indexOf("A enter") > log.indexOf("B exit"), log.join(","));
  assert.equal(existsSync(guard), false);
  await rm(dir, { recursive: true });
});

test("registrations are released on every non-acquisition path and after release, never before", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-lsp-`);
  const lock = `${dir}/x.lock`;
  const base = heldTokenCountForTests();
  const gate = deferred(), inside = deferred();
  const holder = withLock(lock, async () => { inside.resolve(); await gate.promise; });
  await inside.promise;
  assert.equal(heldTokenCountForTests(), base + 1);
  await assert.rejects(withLock(lock, async () => "x", { timeoutMs: 150 }), /lock busy: .*held by live pid/);
  assert.equal(heldTokenCountForTests(), base + 1, "timed-out waiter dropped its registration; holder kept its own");
  gate.resolve(); await holder;
  assert.equal(heldTokenCountForTests(), base);
  await assert.rejects(withLock(lock, async () => { throw new Error("fn failed"); }), /fn failed/);
  assert.equal(heldTokenCountForTests(), base);
  assert.equal(existsSync(lock), false);
  // A failure right after publication removes our own instance before dropping the registration.
  await assert.rejects(withLock(lock, async () => "x", { hooks: { afterPublish: async () => { throw new Error("hook failed"); } } }), /hook failed/);
  assert.equal(existsSync(lock), false);
  assert.equal(heldTokenCountForTests(), base);
  await rm(dir, { recursive: true });
});
