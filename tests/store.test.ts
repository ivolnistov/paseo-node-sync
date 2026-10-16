import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DocStore } from "../server/store.ts";

test("stale revision write returns conflict and keeps the newer value", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-store-`);
  const store = new DocStore<{ n: number }>(`${dir}/doc.json`, { n: 0 });
  const first = await store.read();
  assert.deepEqual(first, { revision: 0, value: { n: 0 } });
  assert.equal((await store.write(first.revision, { n: 1 })).status, "saved");
  assert.deepEqual(await store.write(first.revision, { n: 2 }), { status: "conflict", revision: first.revision + 1 });
  assert.deepEqual((await store.read()).value, { n: 1 });
  assert.deepEqual((await readdir(dir)).sort(), ["doc.json"]);
  await rm(dir, { recursive: true });
});

test("concurrent updates serialize under the lock", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pns-store-`);
  const store = new DocStore<{ n: number }>(`${dir}/doc.json`, { n: 0 });
  await Promise.all(Array.from({ length: 10 }, () => store.update(v => ({ n: v.n + 1 }))));
  assert.deepEqual(await store.read(), { revision: 10, value: { n: 10 } });
  await rm(dir, { recursive: true });
});


