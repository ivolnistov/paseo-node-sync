import { test } from "node:test";
import assert from "node:assert/strict";
import { checkItem, checkBundle } from "../server/capability.ts";

const facts = { pluginRemovalProof: false, selectionPatchable: true, pluginLsShape: true, sessionAttached: true };
test("plugin removal waits for the data preservation proof; unknown plugin list format holds every plugin op", () => {
  assert.deepEqual(checkItem("plugins", "remove", facts), { automatic: false, reason: "plugin-local data restore not yet proven on this Paseo version" });
  assert.deepEqual(checkItem("plugins", "remove", { ...facts, pluginRemovalProof: true }), { automatic: true });
  assert.deepEqual(checkItem("plugins", "install", facts), { automatic: true });
  assert.equal(checkItem("plugins", "install", { ...facts, pluginLsShape: false }).automatic, false);
  assert.equal(checkItem("config", "apply", { ...facts, selectionPatchable: false }, "setting:skills.selection").automatic, false);
  assert.deepEqual(checkItem("skills", "apply", facts, "skill:a"), { automatic: true });
});
test("bundles from a newer protocol or category capability are refused", () => {
  const b = { kind: "data" as const, protocol: 1, capability: 1, setId: "s", incarnation: "incarnation-1", generation: 1, complete: true,
    items: [], tombstones: [], released: [], digest: "x" };
  assert.deepEqual(checkBundle(null, b), { ok: true });
  assert.deepEqual(checkBundle(null, { ...b, capability: 2 }), { ok: false, error: "protocol-unsupported" });
  assert.deepEqual(checkBundle(null, { ...b, protocol: 2 }), { ok: false, error: "protocol-unsupported" });
});
