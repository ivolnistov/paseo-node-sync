import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../server/paths.ts";
import { acceptBundle, readResult, writeResult, pendingGenerations, stageRegistry } from "../server/inbox.ts";
import { bundleDigest } from "../server/canonical.ts";
import { bundle, hex, INC } from "./helpers.ts";

test("generation rules: duplicate idempotent, conflict rejected, stale incarnation rejected", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-inbox-`);
  const paths = nodePaths(home);
  assert.deepEqual(await acceptBundle(paths, null, bundle(1)), { error: "set-not-admitted" });
  assert.deepEqual(await acceptBundle(paths, INC, bundle(1)), { status: "accepted" });
  assert.deepEqual(await acceptBundle(paths, INC, bundle(1)), { status: "duplicate" });
  const other = bundle(1, [{ key: "skill:x", category: "skills", digest: hex("b"), payload: {} }]);
  assert.deepEqual(await acceptBundle(paths, INC, other), { error: "generation-conflict" });
  assert.deepEqual(await acceptBundle(paths, "incarnation-2", bundle(2)), { error: "stale-incarnation" });
  assert.deepEqual(await acceptBundle(paths, INC, bundle(3)), { status: "accepted" });
  assert.deepEqual(await acceptBundle(paths, INC, bundle(2)), { error: "generation-conflict" });
  assert.deepEqual(await pendingGenerations(paths, "skills-home"), [1, 3]);
  assert.equal((await readResult(paths, "skills-home", INC, 3)).status, "pending");
  assert.equal((await readResult(paths, "skills-home", INC, 9)).status, "unknown");
  assert.equal((await readResult(paths, "skills-home", "incarnation-x", 3)).status, "unknown");
  await rm(home, { recursive: true });
});

test("a tampered bundle digest is rejected before staging", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-inbox-`);
  const paths = nodePaths(home);
  const b = { ...bundle(1), complete: false };
  assert.deepEqual(await acceptBundle(paths, INC, b), { error: "bad-schema" });
  assert.deepEqual(await readdir(paths.root).catch(() => []), []);
  await rm(home, { recursive: true });
});

test("results are durable, keyed by incarnation and never re-applied by a duplicate put", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-inbox-`);
  const paths = nodePaths(home);
  await acceptBundle(paths, INC, bundle(1));
  await writeResult(paths, { setId: "skills-home", incarnation: INC, generation: 1, status: "applied", items: [] });
  assert.deepEqual(await readResult(paths, "skills-home", INC, 1), { status: "done", result: { setId: "skills-home", incarnation: INC, generation: 1, status: "applied", items: [] } });
  assert.deepEqual(await acceptBundle(paths, INC, bundle(1)), { status: "duplicate" });
  assert.deepEqual(await pendingGenerations(paths, "skills-home"), []);
  await rm(home, { recursive: true });
});

test("registry bundles stage idempotently and reject a different digest for the same revision", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-inbox-`);
  const paths = nodePaths(home);
  const reg = (owner: string) => { const b = { kind: "registry" as const, protocol: 1, revision: 4, registry: { revision: 4, ownerNodeId: owner, sets: [] } }; return { ...b, digest: bundleDigest(b) }; };
  assert.deepEqual(await stageRegistry(paths, reg("home")), { status: "accepted" });
  assert.deepEqual(await stageRegistry(paths, reg("home")), { status: "duplicate" });
  assert.deepEqual(await stageRegistry(paths, reg("other")), { error: "generation-conflict" });
  await rm(home, { recursive: true });
});

test("node paths reject traversal and malformed ids", () => {
  const paths = nodePaths("/tmp/pns-x");
  for (const id of ["../x", "a/b", "", "UP", "x".repeat(64)]) assert.throws(() => paths.inbox(id), id);
  assert.throws(() => paths.result("ok", 0));
  assert.equal(paths.inbox("skills-home"), "/tmp/pns-x/node-sync/inbox/skills-home");
});
