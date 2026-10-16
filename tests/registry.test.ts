import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DocStore } from "../server/store.ts";
import { requestChange, receiveRegistry, applyChange, overlaps } from "../server/registry.ts";
import type { Registry, RegistryChange, RegistryRequestBundle } from "../shared/protocol.ts";

const empty: Registry = { revision: 0, ownerNodeId: "home", sets: [] };
const create = { op: "create-set" as const, set: { id: "skills-home", source: "home", destination: "work", category: "skills" as const, items: [] } };
const inc = () => "incarnation-0002";

async function deps(role: "owner" | "follower", push?: (b: RegistryRequestBundle) => Promise<void>) {
  const store = new DocStore<Registry>(`${await mkdtemp(`${tmpdir()}/pns-reg-`)}/r.json`, empty);
  const sent: RegistryRequestBundle[] = []; const replicated: Registry[] = [];
  return { sent, replicated, d: { store, node: { nodeId: role === "owner" ? "home" : "work", role },
    pushToOwner: push ?? (async (b: RegistryRequestBundle) => { sent.push(b); }), replicate: async (r: Registry) => { replicated.push(r); },
    newIncarnation: () => "incarnation-0001", now: () => "2026-10-15T00:00:00Z", newRequestId: () => "req-1" } };
}

test("follower edit becomes a request and does not change the local registry", async () => {
  const { d, sent } = await deps("follower");
  assert.deepEqual(await requestChange(d, create), { status: "requested", requestId: "req-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, "registry-request");
  assert.match(sent[0]!.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await d.store.read()).value.revision, 0);
});

test("follower request that cannot reach the owner is reported, not applied", async () => {
  const { d } = await deps("follower", async () => { throw new Error("unreachable"); });
  assert.deepEqual(await requestChange(d, create), { status: "rejected", error: "owner-unreachable" });
  assert.equal((await d.store.read()).value.revision, 0);
});

test("owner applies change, revision advances, registry replicates", async () => {
  const { d, replicated } = await deps("owner");
  assert.deepEqual(await requestChange(d, create), { status: "applied", revision: 1 });
  assert.equal(replicated[0]?.revision, 1);
  assert.equal((await d.store.read()).value.sets[0]?.incarnation, "incarnation-0001");
  assert.deepEqual(await requestChange(d, create), { status: "rejected", error: "duplicate-set" });
});

test("received registry is stored but older or equal revisions are ignored", async () => {
  const { d } = await deps("follower");
  assert.equal((await receiveRegistry(d, { kind: "registry", protocol: 1, revision: 2, registry: { ...empty, revision: 2 }, digest: "x" })).status, "stored");
  assert.equal((await receiveRegistry(d, { kind: "registry", protocol: 1, revision: 1, registry: { ...empty, revision: 1 }, digest: "y" })).status, "ignored-older");
  assert.equal((await receiveRegistry(d, { kind: "registry", protocol: 1, revision: 2, registry: { ...empty, revision: 2 }, digest: "z" })).status, "ignored-older");
});

test("canonical resource overlap", () => {
  assert.equal(overlaps("setting:terminalProfiles", "setting:terminalProfiles[0]"), true);
  assert.equal(overlaps("setting:mcp.injectIntoAgents", "setting:mcp"), true);
  assert.equal(overlaps("setting:mcp", "setting:mcpx"), false);
  assert.equal(overlaps("skill:/x/a", "skill:/x/a"), true);
  assert.equal(overlaps("skill:/x/a", "skill:/x/ab"), false);
  assert.equal(overlaps("profile:a", "plugin:a"), false);
});

test("set invariants: self-plugin, category/key agreement, distinct ends, exclusive resources across sets", () => {
  const plugins = (items: { key: string; resource: string }[]): RegistryChange => ({ op: "create-set", set: { id: "p", source: "home", destination: "work", category: "plugins", items } });
  assert.deepEqual(applyChange(empty, plugins([{ key: "plugin:paseo-node-sync", resource: "plugin:paseo-node-sync" }]), "t", inc), { ok: false, error: "self-plugin" });
  assert.deepEqual(applyChange(empty, plugins([{ key: "skill:a", resource: "skill:/r/a" }]), "t", inc), { ok: false, error: "category-mismatch" });
  assert.deepEqual(applyChange(empty, { op: "create-set", set: { ...create.set, destination: "home" } }, "t", inc), { ok: false, error: "invalid-set" });
  const withSkill = applyChange(empty, { op: "create-set", set: { ...create.set, items: [{ key: "skill:a", resource: "skill:/r/a" }] } }, "t", inc);
  assert.ok(withSkill.ok);
  // Opposite direction is valid on its own, but the same resource cannot be enrolled in two sets (no loops).
  const back = { op: "create-set" as const, set: { id: "skills-work", source: "work", destination: "home", category: "skills" as const, items: [] } };
  const r2 = applyChange(withSkill.registry, back, "t", inc);
  assert.ok(r2.ok);
  assert.deepEqual(applyChange(r2.registry, { op: "enroll", setId: "skills-work", item: { key: "skill:a2", resource: "skill:/r/a" } }, "t", inc), { ok: false, error: "overlap" });
  assert.deepEqual(applyChange(r2.registry, { op: "enroll", setId: "nope", item: { key: "skill:b", resource: "skill:/r/b" } }, "t", inc), { ok: false, error: "unknown-set" });
  const enrolled = applyChange(r2.registry, { op: "enroll", setId: "skills-work", item: { key: "skill:b", resource: "skill:/r/b" } }, "t", inc);
  assert.ok(enrolled.ok && enrolled.registry.revision === r2.registry.revision + 1);
  const un = applyChange(enrolled.registry, { op: "unenroll", setId: "skills-work", key: "skill:b" }, "t", inc);
  assert.ok(un.ok && un.registry.sets.find(s => s.id === "skills-work")!.items.length === 0);
  const del = applyChange(un.registry, { op: "delete-set", setId: "skills-work" }, "t", inc);
  assert.ok(del.ok && del.registry.sets.length === 1);
});
