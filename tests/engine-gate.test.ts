// Stage 2 gate corrections at engine level: recovery failure stays visible and blocks asset writes until it succeeds,
// stop during start, fail-soft sets, quarantined journal holds, the single pause, source + transport problems together,
// and a result without "at".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { makeEnginePair, SET } from "./support/engine-pair.ts";
import { pendingGenerations } from "../server/inbox.ts";
import { Views } from "../server/views.ts";

type Pair = Awaited<ReturnType<typeof makeEnginePair>>;
async function withPair(o: Parameters<typeof makeEnginePair>[0], fn: (p: Pair) => Promise<void>) {
  const p = await makeEnginePair(o);
  try { await fn(p); } finally { await p.cleanup(); }
}
const deferred = () => { let resolve!: () => void; const p = new Promise<void>(r => { resolve = r; }); return { p, resolve }; };

// Recovery fails on a record of another set, so the destination step for this set would itself run fine: only the
// recovery gate keeps it from applying.
let broken = true;
test("a failed start-up recovery keeps ticking, stays visible and blocks asset writes until a retry succeeds", () => withPair({ failActualDigest: k => broken && k === "skill:zzz" }, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  const rec = await p.b.journal.open({ registryRevision: 1, setId: "other-set", incarnation: "x".repeat(8), generation: 1, itemKey: "skill:zzz",
    category: "skills", op: "apply", baselineDigest: null, desiredDigest: null });
  await p.b.journal.advance(rec.opId, "backed-up");
  await p.replaceDestination();
  await p.b.engine.start(); // resolves: the failure is recorded, not latched
  assert.equal(p.b.engine.active.timer, true, "the tick timer is installed although recovery failed");
  assert.equal(p.b.engine.recoveryPending, true);
  assert.match(p.b.engine.lastError?.message ?? "", /recovery: .*simulated unreadable actual state of skill:zzz/);
  await p.source.writeSkill("alpha", "v2"); await p.tickSource();
  await p.b.engine.tick();
  assert.equal(await p.destination.content("alpha"), "v1", "nothing is applied before recovery has run");
  const backup = (await p.destination.backups("skill:alpha"))[0]!;
  assert.match((await p.destination.rollback("skill:alpha", backup.backupId)).detail ?? "", /recovery has not completed/);
  broken = false;
  await p.b.engine.tick();
  assert.equal(p.b.engine.recoveryPending, false);
  assert.equal(await p.destination.content("alpha"), "v2");
  await p.b.engine.stop();
}));

test("stop during start's recovery leaves no timer and refuses later work; start and stop are idempotent", () => withPair({}, async p => {
  await p.replaceDestination();
  const j = p.b.journal, orig = j.unfinished.bind(j);
  const entered = deferred(), gate = deferred();
  j.unfinished = async () => { entered.resolve(); await gate.p; return orig(); };
  const started = p.b.engine.start();
  await entered.p; // start is suspended inside recovery
  const stopping = p.b.engine.stop();
  gate.resolve();
  await stopping; await started;
  assert.deepEqual(p.b.engine.active, { timer: false, debounces: 0, stopped: true });
  await assert.rejects(p.b.engine.tick(), /engine stopped/);
  await p.b.engine.start();
  assert.equal(p.b.engine.active.timer, false, "a stopped engine never starts again");
  p.b.engine.notifyChanged(SET);
  assert.equal(p.b.engine.active.debounces, 0);
  await p.b.engine.stop();
}));

test("a failing set does not stop the other sets in the same tick", () => withPair({ failSet: SET }, async p => {
  const src2 = `${p.homes.a}/second-src`;
  await mkdir(`${src2}/gamma`, { recursive: true }); await writeFile(`${src2}/gamma/SKILL.md`, "g1");
  const real = await realpath(src2);
  await p.a.service.change({ op: "create-set", set: { id: "second", source: "home", destination: "work", category: "skills",
    items: [{ key: "skill:gamma", resource: `skill:${real}/gamma` }] } });
  await p.a.service.admit({ peerId: "work", setId: "second", direction: "outbound" });
  await p.b.service.admit({ peerId: "home", setId: "second", direction: "inbound" });
  await p.a.stores.roots.update(r => ({ ...r, second: [{ path: src2, realpath: real }] }));
  await p.source.writeSkill("alpha", "a1"); // in the failing set, which comes first in the registry
  await p.b.engine.tick(); // the follower stores the replicated registry
  await p.tickSource();
  assert.match(p.a.engine.lastError?.message ?? "", /skills-home \(source\): .*simulated fault/);
  await p.b.engine.tick(); await p.tickSource();
  assert.equal((await p.a.stores.sources.read()).value.second?.ackedGeneration, 1, "the second set was processed in the same ticks");
  assert.equal(await readFile(`${p.paths.b.managedSkills}/gamma/SKILL.md`, "utf8"), "g1");
}));

test("an unreadable journal record is quarantined and holds the whole node until cleared; other work continues", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  const jdir = `${p.paths.b.root}/journal`;
  await mkdir(jdir, { recursive: true });
  await writeFile(`${jdir}/0badc0de.json`, "{ \"setId\": \"skills-home\", truncat");
  await writeFile(`${jdir}/.0badc0de2.json.tmp`, "{ partial"); // an interrupted writeAtomic: never read as a record
  const held = await p.b.journal.open({ registryRevision: 1, setId: SET, incarnation: "x".repeat(8), generation: 9, itemKey: "skill:beta",
    category: "skills", op: "apply", baselineDigest: null, desiredDigest: null });
  await p.b.journal.advance(held.opId, "backed-up"); await p.b.journal.note(held.opId, "failed: install failed (simulated)");
  await p.source.writeSkill("alpha", "v2"); await p.tickSource();
  await p.b.engine.tick();
  const holds = await p.b.engine.holds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.scope, "node", "an unparseable record names no trustworthy set");
  assert.deepEqual((await readdir(`${jdir}/.invalid`)).sort(), [holds[0]!.file, `${holds[0]!.file}.hold`].sort(), "evidence kept, with its marker");
  assert.equal(await readFile(`${jdir}/.invalid/${holds[0]!.file}`, "utf8"), "{ \"setId\": \"skills-home\", truncat");
  assert.ok((await readdir(jdir)).includes(".0badc0de2.json.tmp"), "temp files are not quarantined");
  assert.equal(await p.destination.itemState("skill:beta"), "failed", "valid records are still recovered");
  assert.equal(await p.destination.content("alpha"), "v1", "nothing is applied while held");
  const backup = (await p.destination.backups("skill:alpha"))[0]!;
  assert.match((await p.destination.rollback("skill:alpha", backup.backupId)).detail ?? "", /^held: unparseable journal record/);
  // Registry work is not held.
  await p.source.writeSkill("delta", "d1");
  await p.b.engine.tick();
  assert.equal((await p.b.service.registry.read()).value.revision, (await p.a.service.registry.read()).value.revision);
  assert.equal(await p.b.engine.clearHold(holds[0]!.file), true);
  assert.deepEqual(await p.b.engine.holds(), []);
  await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "v2");
  assert.ok((await readdir(`${jdir}/.invalid`)).includes(holds[0]!.file), "clearing keeps the evidence");
}));

test("an invalid record that still names a known set holds only that set", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  await writeFile(`${p.paths.b.root}/journal/feedface.json`, JSON.stringify({ opId: "feedface", setId: SET, itemKey: "skill:alpha", phase: "half-done" }));
  await p.source.writeSkill("alpha", "v2"); await p.tickSource();
  await p.b.engine.tick();
  const holds = await p.b.engine.holds();
  assert.deepEqual(holds.map(h => [h.scope, h.setId, h.reason]), [["set", SET, "journal record fails validation"]]);
  assert.equal(await p.destination.content("alpha"), "v1");
}));

test("one durable pause works before any runtime exists and survives a restart, on both sides", () => withPair({}, async p => {
  await p.a.engine.setPaused(SET, true);
  await p.b.engine.setPaused(SET, true);
  await p.source.writeSkill("alpha", "v1");
  await p.tickSource();
  assert.equal((await p.source.runtime())?.pending ?? null, null, "a paused source builds nothing");
  await p.restartSource(); await p.restartDestination();
  await p.tickSource();
  assert.equal((await p.source.runtime())?.pending ?? null, null);
  const views = new Views(p.a.service, p.a.stores, p.a.backups);
  assert.deepEqual((await views.runtime()).map(r => [r.side, r.state, r.paused]), [["source", "paused", true]]);
  await p.a.engine.setPaused(SET, false);
  await p.b.engine.tick(); await p.tickSource();
  assert.equal((await p.source.runtime())?.putAccepted, 1, "the source delivers once resumed");
  await p.b.engine.tick();
  assert.deepEqual(await pendingGenerations(p.paths.b, SET), [1], "the paused destination keeps the bundle staged");
  assert.equal(await p.destination.content("alpha"), null);
  await p.b.engine.setPaused(SET, false);
  await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "v1");
  assert.equal(p.applyCount("skill:alpha"), 1);
}));

test("an unreadable source with a failing delivery shows both problems", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  p.offline(true);
  await p.source.writeSkill("alpha", "v2"); await p.tickSource();
  assert.equal((await p.source.runtime())?.state, "peer-offline");
  await p.source.hideRoot(); await p.tickSource();
  const rt = await p.source.runtime();
  assert.equal(rt?.state, "source-unreadable");
  assert.equal(rt?.delivery?.state, "peer-offline");
  const view = (await new Views(p.a.service, p.a.stores, p.a.backups).runtime())[0] as { state: string; delivery?: { state: string } };
  assert.deepEqual([view.state, view.delivery?.state], ["source-unreadable", "peer-offline"]);
  await rename(`${p.source.srcRoot}-hidden`, p.source.srcRoot);
  p.offline(false);
  await p.syncOnce();
  const done = await p.source.runtime();
  assert.deepEqual([done?.state, done?.delivery, await p.destination.content("alpha")], ["idle", undefined, "v2"]);
}));

test("a durable result without \"at\" never overrides an operator-held record; other records are completed", () => withPair({ crashCommit: "after-result" }, async p => {
  await p.source.writeSkill("alpha", "a1"); await p.source.writeSkill("beta", "b1"); await p.syncOnce();
  await p.source.writeSkill("alpha", "a2"); await p.a.engine.tick();
  await p.source.writeSkill("beta", "b2"); await p.a.engine.tick();
  p.armCommitCrash();
  await assert.rejects(p.tickDestination(), /simulated crash/);
  const file = `${p.paths.b.root}/results/${SET}/3.json`;
  const { at: _at, ...legacy } = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify(legacy));
  await p.b.stores.items.update(all => ({ ...all, [SET]: { ...all[SET]!, "skill:alpha": { ...all[SET]!["skill:alpha"]!, state: "paused", updatedAt: "2000-01-01T00:00:00Z" } } }));
  await p.restartDestination();
  const items = (await p.b.stores.items.read()).value[SET]!;
  assert.deepEqual([items["skill:alpha"]?.state, items["skill:alpha"]?.generation], ["paused", 1]);
  assert.deepEqual([items["skill:beta"]?.state, items["skill:beta"]?.generation], ["in-sync", 3]);
  assert.equal((await p.b.stores.destinations.read()).value[SET]?.appliedGeneration, 3);
}));
