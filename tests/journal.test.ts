import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../server/paths.ts";
import { Journal, classifyRecovery, type JournalRecord } from "../server/journal.ts";

const base: JournalRecord = { opId: "o1", registryRevision: 1, setId: "s", incarnation: "incarnation-1", generation: 2,
  itemKey: "skill:a", category: "skills", op: "apply", baselineDigest: "sha256:b", desiredDigest: "sha256:d",
  backupId: "bk", phase: "mutated", updatedAt: "t" };

test("recovery never acts blindly", () => {
  assert.equal(classifyRecovery({ ...base, phase: "intent" }, "sha256:x", { idempotent: true, hasBuild: false }), "discard-intent");
  assert.equal(classifyRecovery(base, "sha256:b", { idempotent: true, hasBuild: false }), "retry");
  assert.equal(classifyRecovery(base, "sha256:d", { idempotent: true, hasBuild: false }), "complete");
  assert.equal(classifyRecovery(base, "sha256:d", { idempotent: false, hasBuild: false }), "blocked: recovery uncertain");
  assert.equal(classifyRecovery(base, "sha256:x", { idempotent: true, hasBuild: false }), "blocked: recovery uncertain");
  assert.equal(classifyRecovery({ ...base, baselineDigest: null }, null, { idempotent: true, hasBuild: false }), "retry");
  assert.equal(classifyRecovery({ ...base, category: "plugins", op: "install" }, "sha256:d", { idempotent: true, hasBuild: true }), "blocked: recovery uncertain");
});

test("records are durable, phases only move forward, and unfinished survives a restart", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-journal-`);
  const paths = nodePaths(home);
  const j = new Journal(paths, () => "2026-10-16T00:00:00Z");
  const r = await j.open({ registryRevision: 1, setId: "s", incarnation: "incarnation-1", generation: 1, itemKey: "skill:a", category: "skills",
    op: "apply", baselineDigest: null, desiredDigest: "sha256:d" });
  assert.equal(r.phase, "intent");
  assert.equal(JSON.parse(await readFile(paths.journal(r.opId), "utf8")).phase, "intent", "intent is on disk before open returns");
  await j.advance(r.opId, "backed-up", { backupId: "b1" });
  await assert.rejects(j.advance(r.opId, "intent"), /journal phase regression/);
  await j.advance(r.opId, "mutated");
  const other = await j.open({ ...r, generation: 2 });
  await j.advance(other.opId, "backed-up"); await j.advance(other.opId, "mutated"); await j.advance(other.opId, "verified");
  const restarted = new Journal(paths);
  assert.deepEqual((await restarted.unfinished()).map(x => [x.opId, x.phase, x.backupId]), [[r.opId, "mutated", "b1"]]);
  await rm(home, { recursive: true });
});
