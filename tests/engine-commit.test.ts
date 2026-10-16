// The destination commit is: durable result -> item records -> appliedGeneration. A crash anywhere after the result
// must converge from the durable result alone: no re-apply, no extra backup, nothing asked of the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { makeEnginePair, SET, type CommitCrash } from "./support/engine-pair.ts";
import { pendingGenerations } from "../server/inbox.ts";

type Pair = Awaited<ReturnType<typeof makeEnginePair>>;
async function withPair(o: Parameters<typeof makeEnginePair>[0], fn: (p: Pair) => Promise<void>) {
  const p = await makeEnginePair(o);
  try { await fn(p); } finally { await p.cleanup(); }
}
const applied = async (p: Pair) => (await p.b.stores.destinations.read()).value[SET]?.appliedGeneration;
const items = async (p: Pair) => (await p.b.stores.items.read()).value[SET] ?? {};
const backupCount = async (p: Pair) => (await p.destination.backups("skill:alpha")).length + (await p.destination.backups("skill:beta")).length;

// g1 applied cleanly; then g2 and g3 are staged at the destination and drained together: g2 superseded, g3 applied.
async function stageAndCrash(p: Pair) {
  await p.source.writeSkill("alpha", "a1"); await p.source.writeSkill("beta", "b1"); await p.syncOnce();
  await p.source.writeSkill("alpha", "a2"); await p.a.engine.tick();
  await p.source.writeSkill("beta", "b2"); await p.a.engine.tick();
  assert.deepEqual(await pendingGenerations(p.paths.b, SET), [2, 3]);
  p.armCommitCrash();
  await assert.rejects(p.tickDestination(), /simulated crash/);
}

for (const point of ["after-result", "mid-items", "before-dest"] as CommitCrash[]) {
  test(`crash ${point}: restart converges bookkeeping from the durable result without re-applying`, () => withPair({ crashCommit: point }, async p => {
    await stageAndCrash(p);
    const appliesAtCrash = [p.applyCount("skill:alpha"), p.applyCount("skill:beta")];
    const backupsAtCrash = await backupCount(p);
    assert.deepEqual(await readdir(`${p.paths.b.inbox(SET)}/superseded`), ["2.json"]);
    if (point !== "before-dest") assert.equal(await applied(p), 1, "the crash left appliedGeneration behind");
    await p.restartDestination();
    assert.equal(await applied(p), 3);
    const rec = await items(p);
    assert.deepEqual([rec["skill:alpha"]?.state, rec["skill:alpha"]?.generation, rec["skill:beta"]?.state, rec["skill:beta"]?.generation], ["in-sync", 3, "in-sync", 3]);
    await p.syncOnce();
    assert.deepEqual([p.applyCount("skill:alpha"), p.applyCount("skill:beta")], appliesAtCrash, "no apply to repair bookkeeping");
    assert.equal(await backupCount(p), backupsAtCrash, "no extra backup");
    const src = await p.source.runtime();
    assert.deepEqual([src?.lastGeneration, src?.ackedGeneration, src?.lastResult?.generation], [3, 3, 3], "the source acknowledged g3 and built nothing new");
    // The latest desired state is available without a source edit: roll back, then resume.
    const back = (await p.destination.backups("skill:alpha")).find(b => b.generation === 3)!;
    assert.equal((await p.destination.rollback("skill:alpha", back.backupId)).state, "paused");
    assert.equal(await p.destination.content("alpha"), "a1");
    await p.destination.resume("skill:alpha");
    assert.equal(await p.destination.content("alpha"), "a2");
    assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
  }));
}

test("reconciliation is idempotent and keeps a newer operator decision", () => withPair({ crashCommit: "after-result" }, async p => {
  await stageAndCrash(p);
  // A record changed after the result was written (newer than the result) must not be overwritten.
  await p.b.stores.items.update(all => ({ ...all, [SET]: { ...all[SET], "skill:beta": { ...all[SET]!["skill:beta"]!, state: "paused",
    detail: "operator decision after the result", updatedAt: "9999-01-01T00:00:00.000Z" } } }));
  await p.restartDestination();
  const once = await items(p);
  assert.equal(once["skill:beta"]?.state, "paused");
  assert.equal(once["skill:alpha"]?.state, "in-sync");
  await p.b.engine.recover(); await p.b.engine.recover();
  assert.deepEqual(await items(p), once, "repeated reconciliation changes nothing");
  assert.equal(await applied(p), 3);
}));

test("a missing outbox bundle the destination never accepted is rebuilt as a new generation, not shown as peer-offline", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "a1"); await p.syncOnce();
  p.offline(true);
  await p.source.writeSkill("alpha", "a2"); await p.syncOnce();
  const before = await p.source.runtime();
  assert.equal(before?.pending, 2); assert.notEqual(before?.putAccepted, 2);
  await rm(p.a.stores.outbox(SET, 2));
  p.offline(false);
  await p.tickSource();
  const after = await p.source.runtime();
  assert.equal(after?.state, "syncing"); assert.match(after?.detail ?? "", /outbox bundle for generation 2 is missing; rebuilding/);
  await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "a2");
  const done = await p.source.runtime();
  assert.equal(done?.lastGeneration, 3); assert.equal(done?.ackedGeneration, 3); assert.notEqual(done?.state, "peer-offline");
  const meta = JSON.parse((await import("node:fs")).readFileSync(p.paths.b.inboxMeta(SET), "utf8"));
  assert.equal(meta.latest, 3); assert.equal(meta.digests["2"], undefined, "the destination never saw generation 2");
}));

test("a missing outbox bundle the destination already accepted is not rebuilt: the result is fetched", () => withPair({ dropFirstFetchResponse: true }, async p => {
  await p.b.engine.tick(); // the follower stores the replicated set first, as in normal operation
  await p.source.writeSkill("alpha", "a1");
  await p.b.engine.tick();
  await p.tickSource(); // put accepted, fetch response lost
  assert.equal((await p.source.runtime())?.putAccepted, 1, JSON.stringify(await p.source.runtime()));
  await rm(p.a.stores.outbox(SET, 1));
  await p.syncOnce();
  const rt = await p.source.runtime();
  assert.deepEqual([rt?.lastGeneration, rt?.ackedGeneration, rt?.lastResult?.status], [1, 1, "applied"]);
  assert.equal(p.applyCount("skill:alpha"), 1);
}));
