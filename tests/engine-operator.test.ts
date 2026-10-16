// Operator decisions vs recovery (stage 2 gate c0042, c0044): keep-destination -> take-source on the same key, and
// rollback/resolve of items that still have unfinished journal records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readlink } from "node:fs/promises";
import { makeEnginePair, SET } from "./support/engine-pair.ts";
import type { JournalRecord } from "../server/journal.ts";

type Pair = Awaited<ReturnType<typeof makeEnginePair>>;
async function withPair(fn: (p: Pair) => Promise<void>) {
  const p = await makeEnginePair({});
  try { await fn(p); } finally { await p.cleanup(); }
}
const detached = async (p: Pair) => (await p.b.stores.destinations.read()).value[SET]?.detached ?? [];
const links = (p: Pair, name: string) => [`${p.homes.b}/.paseo/skills/${name}`, `${p.homes.b}/.claude/skills/${name}`];
async function openRecord(p: Pair, key: string, failed?: string): Promise<JournalRecord> {
  const r = await p.b.journal.open({ registryRevision: 1, setId: SET, incarnation: "x".repeat(8), generation: 9, itemKey: key,
    category: "skills", op: "apply", baselineDigest: null, desiredDigest: null });
  await p.b.journal.advance(r.opId, "backed-up");
  return failed ? p.b.journal.note(r.opId, failed) : p.b.journal.read(r.opId);
}
const unfinishedIds = async (p: Pair) => (await p.b.journal.unfinished()).map(r => r.opId);

test("keep-destination then take-source: stale unowned links fail and keep the detach; after removing them it follows the source again", () => withPair(async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await p.destination.resolve("skill:alpha", "keep-destination");
  for (const l of links(p, "alpha")) assert.equal(await readlink(l), p.destination.managed("alpha"), "release leaves the links on disk");
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "unmanaged");
  const open = await openRecord(p, "skill:alpha"); // an unrelated earlier operation left a record for this item

  const failed = await p.destination.resolve("skill:alpha", "take-source");
  assert.equal(failed.state, "blocked: local change");
  assert.match(failed.detail ?? "", /unmanaged collision/, "released links are not re-adopted");
  assert.deepEqual(await detached(p), ["skill:alpha"], "a failed take keeps the detach");
  assert.ok((await unfinishedIds(p)).includes(open.opId), "a failed take closes nothing");
  await p.source.writeSkill("alpha", "v3"); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "unmanaged");
  assert.equal(await p.destination.content("alpha"), "v1");

  for (const l of links(p, "alpha")) await rm(l); // the operator removes the old links
  const took = await p.destination.resolve("skill:alpha", "take-source");
  assert.equal(took.state, "in-sync");
  assert.equal(await p.destination.content("alpha"), "v3");
  assert.deepEqual(await detached(p), [], "a validated in-sync take ends the detach");
  const closed = await p.b.journal.read(open.opId);
  assert.equal(closed.phase, "reported");
  assert.match(closed.detail ?? "", /^closed by operator: take-source; was: unfinished at phase backed-up$/);
  await p.source.writeSkill("alpha", "v4"); await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "v4", "later generations follow the source");
  assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
}));

test("rollback of a failed operation stays paused through ticks and a restart; the record is closed with its failure kept", () => withPair(async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  const rec = await openRecord(p, "skill:alpha", "failed: install failed (simulated)");
  await p.b.engine.tick();
  assert.equal(await p.destination.itemState("skill:alpha"), "failed");
  const backup = (await p.destination.backups("skill:alpha")).find(b => b.generation === 2)!;
  assert.equal((await p.destination.rollback("skill:alpha", backup.backupId)).state, "paused");
  const closed = await p.b.journal.read(rec.opId);
  assert.equal(closed.phase, "reported");
  assert.equal(closed.detail, `closed by operator: rolled back to ${backup.backupId}; was: failed: install failed (simulated)`);
  await p.source.writeSkill("alpha", "v3"); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "paused");
  await p.restartDestination(); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "paused");
  assert.equal(await p.destination.content("alpha"), "v1");
  assert.deepEqual(await unfinishedIds(p), []);
}));

test("recovery keeps a held state newer than a record and leaves the record unfinished; a newer record is still processed", () => withPair(async p => {
  await p.source.writeSkill("alpha", "v1"); await p.source.writeSkill("beta", "b1"); await p.syncOnce();
  const stale = await openRecord(p, "skill:alpha", "failed: install failed (simulated)");
  const uncertain = await openRecord(p, "skill:beta");
  // alpha: decided after its record; beta: decided at exactly its record's timestamp (a tie never overrides a decision).
  const decided = new Date(Date.parse(stale.updatedAt) + 1).toISOString();
  await p.b.stores.items.update(all => ({ ...all, [SET]: { ...all[SET]!,
    "skill:alpha": { ...all[SET]!["skill:alpha"]!, state: "paused", detail: "operator", updatedAt: decided },
    "skill:beta": { ...all[SET]!["skill:beta"]!, state: "blocked: local change", detail: "operator", updatedAt: uncertain.updatedAt } } }));
  await p.b.engine.tick(); await p.restartDestination(); await p.b.engine.tick();
  assert.equal(await p.destination.itemState("skill:alpha"), "paused");
  assert.equal(await p.destination.itemState("skill:beta"), "blocked: local change");
  assert.deepEqual((await unfinishedIds(p)).sort(), [stale.opId, uncertain.opId].sort(), "evidence is retained");
  assert.equal((await p.b.journal.read(stale.opId)).detail, "failed: install failed (simulated)");

  // A held state OLDER than a record: that record is a later operation, processed as usual.
  await p.b.stores.items.update(all => ({ ...all, [SET]: { ...all[SET]!,
    "skill:alpha": { ...all[SET]!["skill:alpha"]!, state: "paused", updatedAt: "2000-01-01T00:00:00.000Z" } } }));
  await p.b.engine.tick();
  assert.equal(await p.destination.itemState("skill:alpha"), "failed");
}));

test("a failed rollback or take-source closes no earlier record", () => withPair(async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  const rec = await openRecord(p, "skill:alpha");
  await p.destination.editManaged("alpha", "local");
  const backup = (await p.destination.backups("skill:alpha")).find(b => b.generation === 2)!;
  assert.equal((await p.destination.rollback("skill:alpha", backup.backupId)).state, "blocked: local change", "normal drift guard");
  const ghost = await openRecord(p, "skill:ghost");
  assert.equal((await p.destination.resolve("skill:ghost", "take-source")).detail, "no desired state received for this item yet");
  const after = await p.b.journal.unfinished();
  assert.deepEqual(after.map(r => r.opId).sort(), [rec.opId, ghost.opId].sort());
  assert.ok(after.every(r => r.phase === "backed-up" && r.detail === undefined), "records unchanged");
  assert.equal(await p.destination.content("alpha"), "local");
}));
