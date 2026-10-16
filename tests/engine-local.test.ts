// Stage 2 gate c0101 (a rejected generation never becomes the desired anchor) and c0102 (a corrupt retained outbox
// bundle is local state, not a thrown error or a transport failure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { makeEnginePair, SET } from "./support/engine-pair.ts";
import { handleRequest } from "../server/receiver/handle.ts";
import { bundleDigest } from "../server/canonical.ts";
import { pendingGenerations } from "../server/inbox.ts";
import type { DataBundle } from "../shared/protocol.ts";

type Pair = Awaited<ReturnType<typeof makeEnginePair>>;
async function withPair(o: Parameters<typeof makeEnginePair>[0], fn: (p: Pair) => Promise<void>) {
  const p = await makeEnginePair(o);
  try { await fn(p); } finally { await p.cleanup(); }
}
const applied = async (p: Pair) => (await p.b.stores.destinations.read()).value[SET]?.appliedGeneration;

test("a rejected higher generation leaves the applied pointer, items and content alone; operator actions use the last applied bundle", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "v1"); await p.syncOnce();
  const g1 = JSON.parse(await readFile(p.a.stores.outbox(SET, 1), "utf8")) as DataBundle;
  const { digest: _d, ...body } = g1;
  // Generation 2 from the source's peer, but for a capability this node does not support (and carrying no items).
  const g2body = { ...body, generation: 2, capability: 99, items: [], tombstones: [], released: [] };
  const put = await handleRequest(p.paths.b, "home", { verb: "put", bundle: { ...g2body, digest: bundleDigest(g2body) } as DataBundle });
  assert.equal(put.ok, true, JSON.stringify(put));
  const itemsBefore = (await p.b.stores.items.read()).value[SET];
  const backupsBefore = (await p.destination.backups("skill:alpha")).length, appliesBefore = p.applyCount("skill:alpha");

  await p.b.engine.tick(); await p.b.engine.tick(); // repeated drains
  const r2 = JSON.parse(await readFile(`${p.paths.b.root}/results/${SET}/2.json`, "utf8"));
  assert.deepEqual([r2.status, r2.reason], ["rejected", "protocol-unsupported"]);
  assert.equal(await applied(p), 1, "the pointer stays at the last applied generation");
  assert.deepEqual((await p.b.stores.items.read()).value[SET], itemsBefore);
  assert.deepEqual(await pendingGenerations(p.paths.b, SET), []);
  assert.equal(await p.destination.content("alpha"), "v1");
  assert.equal((await p.destination.backups("skill:alpha")).length, backupsBefore);
  assert.equal(p.applyCount("skill:alpha"), appliesBefore);

  // take-source resolves against g1 (the rejected g2 has no alpha at all).
  await p.destination.editManaged("alpha", "local");
  const took = await p.destination.resolve("skill:alpha", "take-source");
  assert.equal(took.state, "in-sync", JSON.stringify(took));
  assert.equal(await p.destination.content("alpha"), "v1");
  assert.equal(await applied(p), 1);

  // The next valid generation advances normally (the source moves past the conflicting 2).
  await p.source.writeSkill("alpha", "v2"); await p.syncOnce();
  assert.equal(await p.destination.content("alpha"), "v2");
  assert.equal(await applied(p), 3);
}));

test("a corrupt outbox bundle never accepted is rebuilt as a new generation, not reported as a network failure", () => withPair({}, async p => {
  await p.source.writeSkill("alpha", "a1"); await p.syncOnce();
  p.offline(true);
  await p.source.writeSkill("alpha", "a2"); await p.tickSource();
  assert.equal((await p.source.runtime())?.pending, 2);
  await writeFile(p.a.stores.outbox(SET, 2), "{\"kind\":\"data\",\"generation\":2,trunc");
  p.offline(false);
  await p.tickSource();
  const rt = await p.source.runtime();
  assert.equal(rt?.state, "syncing");
  assert.match(rt?.detail ?? "", /generation 2 is unreadable or corrupt; rebuilding/);
  assert.equal(p.a.engine.lastError, null, "no thrown parse error");
  assert.equal(await readFile(p.a.stores.outbox(SET, 2), "utf8"), "{\"kind\":\"data\",\"generation\":2,trunc", "evidence is kept");
  await p.syncOnce();
  const done = await p.source.runtime();
  assert.deepEqual([done?.lastGeneration, done?.ackedGeneration, done?.state], [3, 3, "idle"]);
  assert.equal(await p.destination.content("alpha"), "a2");
}));

test("a corrupt outbox bundle the destination already accepted is only fetched: one apply, one backup", () => withPair({ dropFirstFetchResponse: true }, async p => {
  await p.b.engine.tick();
  await p.source.writeSkill("alpha", "a1");
  await p.b.engine.tick();
  await p.tickSource(); // put accepted, fetch response lost
  assert.equal((await p.source.runtime())?.putAccepted, 1);
  await writeFile(p.a.stores.outbox(SET, 1), "not json at all");
  await p.syncOnce();
  const rt = await p.source.runtime();
  assert.deepEqual([rt?.lastGeneration, rt?.ackedGeneration, rt?.state], [1, 1, "idle"]);
  assert.equal(p.a.engine.lastError, null);
  assert.equal(p.applyCount("skill:alpha"), 1);
  assert.equal((await p.destination.backups("skill:alpha")).length, 1);
  assert.deepEqual((await readdir(`${p.paths.b.root}/results/${SET}`)).sort(), ["1.json"]);
}));
