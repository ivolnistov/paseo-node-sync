// Stage 3: daemon config driver (profiles and allowlisted settings) against an in-memory 0.11.1-shaped daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPatch } from "../server/appliers/config.ts";
import { absoluteHomePath, desiredConfigItems, portableProfile, readPath } from "../server/snapshot/config.ts";
import { digest } from "../server/canonical.ts";
import { makeConfigFixture } from "./support/config-fixture.ts";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

const prof = (id: string, extra: object = {}) => ({ id, name: id, provider: "claude", ...extra });
const cfg = (c: object) => c as unknown as MutableDaemonConfig;

test("profile patch replaces only the managed entry and keeps the rest from preflight", () => {
  const current = cfg({ agentProfiles: [prof("mine", { model: "a", localOnly: 1 }), prof("theirs")] });
  assert.deepEqual(buildPatch(current, "profile:mine", prof("mine", { model: "b" })),
    { agentProfiles: [prof("mine", { model: "b", localOnly: 1 }), prof("theirs")] }, "non-portable fields of the managed entry stay");
  assert.deepEqual(buildPatch(current, "profile:new", prof("new")), { agentProfiles: [...current.agentProfiles!, prof("new")] });
  assert.deepEqual(buildPatch(current, "profile:mine", undefined), { agentProfiles: [prof("theirs")] });
  assert.deepEqual(buildPatch(cfg({}), "setting:mcp.injectIntoAgents", false), { mcp: { injectIntoAgents: false } });
  assert.deepEqual(buildPatch(cfg({}), "setting:terminalProfiles", [{ id: "t", name: "t", command: "bash" }]), { terminalProfiles: [{ id: "t", name: "t", command: "bash" }] });
});

test("excluded, non-allowlisted and selection fields are never patched", () => {
  for (const k of ["setting:relay.enabled", "setting:pluginsEnabled", "setting:plugins", "setting:providers.claude.enabled", "setting:removeProviders",
    "setting:hostnames", "setting:skills.selection"]) assert.throws(() => buildPatch(cfg({}), k, false), k);
  assert.throws(() => buildPatch(cfg({}), "setting:autoArchiveAfterMerge", undefined), /removal not supported/);
});

test("unrelated profile edit before preflight survives the managed rewrite", async () => {
  const f = await makeConfigFixture({ agentProfiles: [] });
  assert.equal((await f.applyProfile(prof("mine", { model: "a" }))).state, "in-sync");
  await f.port.patch(cfg({ agentProfiles: [...(await f.port.get()).agentProfiles!, prof("local-only")] }));
  const r = await f.applyProfile(prof("mine", { model: "b" }));
  assert.equal(r.state, "in-sync");
  assert.deepEqual((await f.port.get()).agentProfiles!.map(p => [p.id, p.model]), [["mine", "b"], ["local-only", undefined]]);
});

test("preflight drift blocks apply and delete; nothing is written", async () => {
  const f = await makeConfigFixture({ agentProfiles: [] });
  await f.applyProfile(prof("mine", { model: "a" }));
  await f.port.patch(cfg({ agentProfiles: [prof("mine", { model: "edited-here" })] }));
  const patches = f.calls.patch.length;
  assert.equal((await f.applyProfile(prof("mine", { model: "b" }))).state, "blocked: local change");
  assert.equal((await f.deleteProfile("mine")).state, "blocked: local change");
  assert.equal(f.calls.patch.length, patches);
  assert.equal((await f.port.get()).agentProfiles![0]!.model, "edited-here");
  assert.equal((await f.applyProfile(prof("mine", { model: "b" }), { acceptDrift: true })).state, "in-sync", "take-source skips only the drift check");
});

test("an existing unmanaged profile with the same id is not overwritten", async () => {
  const f = await makeConfigFixture({ agentProfiles: [prof("mine", { model: "theirs" })] });
  const r = await f.applyProfile(prof("mine", { model: "ours" }));
  assert.deepEqual([r.state, r.detail], ["blocked: local change", "a profile with this id exists here and is not managed"]);
  assert.equal(f.calls.patch.length, 0);
});

test("profile delete removes only that entry, keeps a backup and the baseline is cleared", async () => {
  const f = await makeConfigFixture({ agentProfiles: [prof("other")] });
  await f.applyProfile(prof("mine"));
  const r = await f.deleteProfile("mine");
  assert.equal(r.state, "deleted (backup kept)");
  assert.deepEqual((await f.port.get()).agentProfiles!.map(p => p.id), ["other"]);
  assert.deepEqual(await f.backups.readValue(r.backupId!), { value: prof("mine") });
  assert.equal(f.baselines.get("profile:mine"), null);
});

test("missing provider blocks profiles and metadata providers; home paths block", async () => {
  const f = await makeConfigFixture({ agentProfiles: [] }, { providers: ["claude"] });
  assert.equal((await f.applyProfile(prof("x", { provider: "codex" }))).state, "blocked: provider missing");
  assert.equal((await f.applySetting("metadataGeneration.providers", [{ provider: "claude" }, { provider: "codex" }])).state, "blocked: provider missing");
  assert.equal(portableProfile(prof("y", { featureValues: { dir: "/Users/someone/x" } })).ok, false);
  assert.equal((await f.applySetting("terminalProfiles", [{ id: "t", name: "t", command: "/home/lab/bin/x" }])).state, "blocked: unsafe path");
  assert.equal(absoluteHomePath({ a: [{ b: "/root/.ssh" }] }), "/root/.ssh");
  assert.equal(f.calls.patch.length, 0);
});

test("incoming payloads are validated independently: wrong id, extra fields, excluded keys, digest", async () => {
  const f = await makeConfigFixture({ agentProfiles: [] });
  const p = prof("mine");
  assert.match((await f.applyRaw({ key: "profile:other", category: "config", digest: digest(p), payload: p })).detail ?? "", /id does not match/);
  const extra = { ...p, apiKey: "x" };
  assert.match((await f.applyRaw({ key: "profile:mine", category: "config", digest: digest(extra), payload: extra })).detail ?? "", /only portable fields/);
  assert.equal((await f.applyRaw({ key: "setting:relay.enabled", category: "config", digest: digest(false), payload: false })).state, "blocked: unsafe path");
  assert.equal((await f.applyRaw({ key: "setting:autoArchiveAfterMerge", category: "config", digest: digest("yes"), payload: "yes" })).state, "blocked: unsafe path");
  assert.equal(f.calls.patch.length, 0);
});

test("read-back mismatch is failed with backup available and the record held", async () => {
  const f = await makeConfigFixture({ agentProfiles: [] }, { patchDropsProfiles: true });
  const r = await f.applyProfile(prof("mine"));
  assert.equal(r.state, "failed");
  assert.ok(r.backupId);
  assert.notEqual(r.desiredDigest, r.actualDigest);
  const [rec] = await f.journal.unfinished();
  assert.deepEqual([rec?.phase, rec?.detail], ["mutated", "failed: read-back mismatch"]);
  assert.equal(f.baselines.get("profile:mine"), undefined, "no baseline for an unverified value");
});

test("scalar and array settings: first apply backs up the existing value; arrays are whole", async () => {
  const f = await makeConfigFixture({ terminalProfiles: [{ id: "old", name: "old", command: "zsh" }] });
  const r = await f.applySetting("autoArchiveAfterMerge", true);
  assert.equal(r.state, "in-sync");
  assert.deepEqual(await f.backups.readValue(r.backupId!), { value: false });
  assert.deepEqual(f.calls.patch.at(-1), { autoArchiveAfterMerge: true });
  const t = [{ id: "a", name: "a", command: "bash", args: ["-l"] }];
  assert.equal((await f.applySetting("terminalProfiles", t)).state, "in-sync");
  assert.deepEqual((await f.port.get()).terminalProfiles, t);
  assert.equal((await f.deleteSetting("autoArchiveAfterMerge")).state, "awaiting-operator");
});

test("skills.selection uses the dedicated route, never config.patch, and never confirms removals itself", async () => {
  const f = await makeConfigFixture({}, { installedSkills: ["paseo-a", "paseo-b"] });
  const keep = { mode: "custom", skills: ["paseo-a", "paseo-b"] };
  assert.equal((await f.applySetting("skills.selection", keep)).state, "in-sync");
  assert.deepEqual(readPath(await f.port.get(), "skills.selection"), keep);
  const narrower = { mode: "custom", skills: ["paseo-a"] };
  const r = await f.applySetting("skills.selection", narrower);
  assert.equal(r.state, "awaiting-operator");
  assert.match(r.detail ?? "", /would remove installed skills \(paseo-b\)/);
  assert.deepEqual(readPath(await f.port.get(), "skills.selection"), keep, "previous selection kept");
  assert.equal(f.calls.patch.length, 0, "config.patch never carries skills.selection");
  assert.deepEqual(await f.journal.unfinished(), [], "the refused save is closed as not applied");
  const noRoute = await makeConfigFixture({}, { noSelectionRoute: true });
  assert.equal((await noRoute.applySetting("skills.selection", keep)).state, "pending");
});

test("no session means pending, not blocked or unsupported", async () => {
  const f = await makeConfigFixture({ agentProfiles: [] }, { noSession: true });
  const r = await f.applyProfile(prof("mine"));
  assert.deepEqual([r.state, r.detail], ["pending", "waiting for Paseo session"]);
  assert.equal((await f.driver.snapshot(f.set)).status, "unreadable");
  await assert.rejects(f.driver.actualDigest("profile:mine"), /waiting for Paseo session/);
});

test("rollback restores a backed-up value through the same checks", async () => {
  const f = await makeConfigFixture({});
  const first = await f.applySetting("appendSystemPrompt", "v1");
  await f.applySetting("appendSystemPrompt", "v2");
  const r = await f.driver.restore(f.set, 9, "setting:appendSystemPrompt", first.backupId!);
  assert.equal(r.state, "in-sync");
  assert.equal((await f.port.get()).appendSystemPrompt, "", "the backup of the first apply holds the value before it");
});

test("source snapshot: only enrolled keys, portable projection, tombstones and blocked", () => {
  const c = { agentProfiles: [prof("a", { secretish: "x" }), prof("home", { featureValues: { cwd: "/home/me/p" } })], autoArchiveAfterMerge: true,
    relay: { enabled: true } };
  const s = desiredConfigItems(c, [{ key: "profile:a", resource: "profile:a" }, { key: "profile:gone", resource: "profile:gone" },
    { key: "profile:home", resource: "profile:home" }, { key: "setting:autoArchiveAfterMerge", resource: "setting:autoArchiveAfterMerge" },
    { key: "setting:relay.enabled", resource: "setting:relay.enabled" }]);
  assert.deepEqual(s.items.map(i => [i.key, i.payload]), [["profile:a", prof("a")], ["setting:autoArchiveAfterMerge", true]]);
  assert.deepEqual(s.missing, ["profile:gone"]);
  assert.deepEqual(s.blocked.map(b => b.key), ["profile:home", "setting:relay.enabled"]);
});
