import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, readdir, rm, lstat } from "node:fs/promises";
import { makeEnginePair, SET } from "./support/engine-pair.ts";
import { scanRoot } from "../server/snapshot/skills.ts";

type Pair = Awaited<ReturnType<typeof makeEnginePair>>;
async function withPair(o: Parameters<typeof makeEnginePair>[0], fn: (p: Pair) => Promise<void>) {
  const p = await makeEnginePair(o);
  try { await fn(p); } finally { await p.cleanup(); }
}

test("first sync applies the skill and the source sees the destination's result", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "v1");
  assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
  const rt = await p.source.runtime();
  assert.equal(rt?.pending, null); assert.equal(rt?.lastResult?.status, "applied");
  assert.equal(rt?.sourceItems["skill:alpha"]?.state, "in-sync");
  assert.ok((await lstat(`${p.homes.b}/.claude/skills/alpha`)).isSymbolicLink());
}));

test("lost fetch-result response re-fetches and never re-applies", () => withPair({ dropFirstFetchResponse: true }, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  assert.equal(p.applyCount("skill:alpha"), 1);
  assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
  const rt = await p.source.runtime();
  assert.equal(rt?.lastResult?.status, "applied"); assert.equal(rt?.lastGeneration, 1, "no new generation for the same content");
}));

test("duplicate put of the same generation is idempotent", () => withPair({ duplicatePut: true }, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  assert.equal(p.applyCount("skill:alpha"), 1);
}));

test("newest desired state supersedes while offline; older conflicts survive", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await p.destination.editManaged("alpha", "local");
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "blocked: local change");
  p.offline(true);
  await p.source.writeSkill("beta", "b1"); await p.syncOnce();
  await p.source.writeSkill("beta", "b2"); await p.syncOnce();
  assert.equal(await p.source.setState(), "peer-offline");
  p.offline(false); await p.syncOnce();
  assert.equal(await p.destination.content("beta"), "b2");
  assert.equal(p.applyCount("skill:beta"), 1, "only the newest state was applied");
  assert.equal(await p.destination.itemState("skill:alpha"), "blocked: local change");
  assert.equal(await p.destination.content("alpha"), "local");
}));

test("unreadable source root sends no tombstones and keeps the destination copy", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await p.source.hideRoot(); await p.syncOnce();
  assert.equal(await p.source.setState(), "source-unreadable");
  assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
  assert.equal(await p.destination.content("alpha"), "v1");
}));

test("an unsafe source skill is reported blocked at the source and the destination copy is left alone", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await symlink("../../outside", `${p.source.srcRoot}/alpha/escape`);
  await p.source.writeSkill("alpha", "v1-with-link"); await p.syncOnce();
  assert.equal((await p.source.runtime())?.sourceItems["skill:alpha"]?.state, "blocked: unsafe path");
  assert.equal(await p.destination.content("alpha"), "v1");
  assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
}));

test("source deletion removes the managed copy; un-enrollment leaves it unmanaged", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.source.writeSkill("beta", "v1"); await p.syncOnce();
  await p.source.deleteSkill("alpha"); await p.source.unenroll("skill:beta"); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "deleted (backup kept)");
  assert.equal(await p.destination.content("alpha"), null);
  assert.equal(await p.destination.itemState("skill:beta"), "unmanaged");
  assert.equal(await p.destination.content("beta"), "v1");
}));

for (const crashAt of ["backed-up", "mutated", "verified"] as const) {
  test(`restart after ${crashAt} recovers without blind action`, () => withPair({ crashDestinationAfter: crashAt }, async p => {
    await p.source.writeSkill("alpha", "v1"); await p.syncOnce().catch(() => {});
    await p.restartDestination(); await p.syncOnce();
    assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
    assert.equal(await p.destination.content("alpha"), "v1");
    assert.deepEqual(await p.b.journal.unfinished(), []);
  }));
}

test("restart after mutation with a foreign change becomes recovery uncertain", () => withPair({ crashDestinationAfter: "mutated" }, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce().catch(() => {});
  await p.destination.editManaged("alpha", "foreign");
  await p.restartDestination(); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "blocked: recovery uncertain");
  assert.equal(await p.destination.content("alpha"), "foreign");
}));

test("a recorded failure is held for the operator and never retried blindly", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  const rec = await p.b.journal.open({ registryRevision: 1, setId: SET, incarnation: "x".repeat(8), generation: 9, itemKey: "skill:alpha",
    category: "skills", op: "apply", baselineDigest: null, desiredDigest: null });
  await p.b.journal.advance(rec.opId, "backed-up"); await p.b.journal.note(rec.opId, "failed: install failed (simulated)");
  await p.restartDestination();
  assert.equal(await p.destination.itemState("skill:alpha"), "failed");
  const applies = p.applyCount("skill:alpha");
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  assert.equal(p.applyCount("skill:alpha"), applies, "no apply while the failure is unresolved");
  assert.equal(await p.destination.content("alpha"), "v1");
  await p.destination.resolve("skill:alpha", "take-source");
  assert.equal(await p.destination.content("alpha"), "v2");
  assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
  assert.deepEqual(await p.b.journal.unfinished(), [], "the operator's resolution closes the failed record");
}));

test("conflict resolution: take-source backs up and applies; keep-destination detaches the item", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.source.writeSkill("beta", "b1"); await p.syncOnce();
  await p.destination.editManaged("alpha", "local-a"); await p.destination.editManaged("beta", "local-b");
  await p.source.writeSkill("alpha", "v2"); await p.source.writeSkill("beta", "b2"); await p.syncOnce();
  assert.equal(await p.destination.itemState("skill:alpha"), "blocked: local change");
  const took = await p.destination.resolve("skill:alpha", "take-source");
  assert.equal(took.state, "in-sync"); assert.equal(await p.destination.content("alpha"), "v2");
  assert.ok((await p.destination.backups("skill:alpha")).some(b => b.backupId === took.backupId), "the local version was backed up first");
  await p.destination.resolve("skill:beta", "keep-destination");
  await p.source.writeSkill("beta", "b3"); await p.syncOnce();
  assert.equal(await p.destination.content("beta"), "local-b");
  assert.equal(await p.destination.itemState("skill:beta"), "unmanaged");
}));

test("rollback pauses the item; resume applies the latest after preflight", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  const backup = (await p.destination.backups("skill:alpha")).find(b => b.generation === 2)!;
  const r = await p.destination.rollback("skill:alpha", backup.backupId);
  assert.equal(r.state, "paused");
  assert.equal(await p.destination.content("alpha"), "v1");
  await p.source.writeSkill("alpha", "v3"); await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "v1", "paused items record but do not apply");
  await p.destination.resume("skill:alpha"); await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "v3");
  assert.equal(await p.destination.itemState("skill:alpha"), "in-sync");
}));

test("rollback never overwrites an unmanaged change made after the last apply", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  await p.destination.editManaged("alpha", "local");
  const backup = (await p.destination.backups("skill:alpha")).find(b => b.generation === 2)!;
  assert.equal((await p.destination.rollback("skill:alpha", backup.backupId)).state, "blocked: local change");
  assert.equal(await p.destination.content("alpha"), "local");
}));

test("transient applier directories are never candidate skills", async () => {
  const p = await makeEnginePair();
  try {
    await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
    await mkdir(`${p.paths.b.managedSkills}/.staging-abc/alpha`, { recursive: true });
    await mkdir(`${p.paths.b.managedSkills}/.trash-abc`, { recursive: true });
    const scan = await scanRoot({ path: p.paths.b.managedSkills, realpath: p.paths.b.managedSkills });
    assert.deepEqual(scan.status === "ok" && scan.skills.map(s => s.name), ["alpha"]);
  } finally { await p.cleanup(); }
});

test("registry: a stale follower request is rejected visibly; the follower fetches the outcome; nothing is rebased", () => withPair({}, async p => {
  // The follower's view is at revision 1; the owner moves on before the request is processed.
  await p.syncOnce();
  const req = await p.b.service.change({ op: "create-set", set: { id: "skills-work", source: "work", destination: "home", category: "skills", items: [] } });
  assert.equal(req.status, "requested");
  await p.a.service.change({ op: "create-set", set: { id: "skills-other", source: "home", destination: "work", category: "skills", items: [] } });
  await p.syncOnce();
  const sets = (await p.a.service.registry.read()).value.sets.map(s => s.id);
  assert.ok(!sets.includes("skills-work"), "a stale request is not applied");
  const outcome = Object.values((await p.b.stores.requests.read()).value)[0]!;
  assert.equal(outcome.status, "rejected"); assert.match(outcome.error ?? "", /^stale-base: request based on revision \d+, owner is at \d+/);
  // A fresh request on the current revision is applied and the follower learns it.
  const again = await p.b.service.change({ op: "create-set", set: { id: "skills-work", source: "work", destination: "home", category: "skills", items: [] } });
  await p.syncOnce();
  assert.equal((await p.b.stores.requests.read()).value[(again as { requestId: string }).requestId]?.status, "applied");
  assert.ok((await p.b.service.registry.read()).value.sets.some(s => s.id === "skills-work"), "replicated to the follower");
}));

test("registry: replication to an offline follower is retried durably with the newest revision after an owner restart", () => withPair({}, async p => {
  await p.syncOnce();
  p.offline(true);
  await p.a.service.change({ op: "create-set", set: { id: "skills-x1", source: "home", destination: "work", category: "skills", items: [] } });
  await p.a.service.change({ op: "create-set", set: { id: "skills-x2", source: "home", destination: "work", category: "skills", items: [] } });
  const behind = (await p.a.stores.replication.read()).value.work!;
  assert.ok(behind.acked < (await p.a.service.registry.read()).value.revision && behind.lastError, JSON.stringify(behind));
  await p.restartSource(); // the follower-behind marker must come from disk, not memory
  p.offline(false);
  await p.syncOnce();
  const r = (await p.a.service.registry.read()).value.revision;
  assert.equal((await p.a.stores.replication.read()).value.work!.acked, r);
  assert.equal((await p.b.service.registry.read()).value.revision, r);
}));

test("registry: a corrupt staged entry is quarantined and does not block the others", () => withPair({}, async p => {
  await mkdir(p.paths.b.registryInbox, { recursive: true });
  await writeFile(`${p.paths.b.registryInbox}/registry-999.json`, "{ not json");
  await p.a.service.change({ op: "create-set", set: { id: "skills-x1", source: "home", destination: "work", category: "skills", items: [] } });
  await p.syncOnce();
  assert.deepEqual(await readdir(`${p.paths.b.registryInbox}/quarantine`), ["registry-999.json"]);
  assert.ok((await p.b.service.registry.read()).value.sets.some(s => s.id === "skills-x1"));
  await rm(`${p.paths.b.registryInbox}/quarantine`, { recursive: true });
}));
