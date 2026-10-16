import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, resolveBinding, forcedCommand, type PeerBinding } from "../server/peers.ts";
import { bundle } from "./helpers.ts";

const home: PeerBinding = { peerId: "home", hostKey: "h", publicKey: "k", verbs: ["put", "fetch-result"],
  sets: [{ setId: "skills-home", direction: "inbound" }, { setId: "skills-work", direction: "outbound" }], registryRole: "owner", admittedAt: "t" };
const fetch = (setId: string) => ({ verb: "fetch-result" as const, setId, incarnation: "incarnation-1", generation: 1 });

test("authorization matrix", () => {
  assert.equal(resolveBinding([home], "home"), home);
  assert.equal(resolveBinding([home], "stranger"), null);
  assert.deepEqual(authorize(null, fetch("skills-home")), { ok: false, error: "unbound-peer" });
  assert.deepEqual(authorize({ ...home, verbs: ["fetch-result"] }, { verb: "put", bundle: bundle(1) }), { ok: false, error: "verb-not-permitted" });
  assert.deepEqual(authorize(home, fetch("other")), { ok: false, error: "set-not-admitted" });
  assert.deepEqual(authorize(home, { verb: "put", bundle: bundle(1, [], { setId: "skills-work" }) }), { ok: false, error: "direction-not-permitted" });
  assert.deepEqual(authorize(home, { verb: "put", bundle: bundle(1) }), { ok: true });
  assert.deepEqual(authorize(home, fetch("_hello")), { ok: true });
  const reg = { kind: "registry" as const, protocol: 1, revision: 1, registry: { revision: 1, ownerNodeId: "home", sets: [] }, digest: "x" };
  const req = { kind: "registry-request" as const, protocol: 1, requestId: "r1", baseRevision: 1, change: { op: "delete-set" as const, setId: "s" }, digest: "x" };
  assert.deepEqual(authorize(home, { verb: "put", bundle: reg }), { ok: true });
  assert.deepEqual(authorize(home, { verb: "put", bundle: req }), { ok: false, error: "verb-not-permitted" });
  assert.deepEqual(authorize({ ...home, registryRole: "follower" }, { verb: "put", bundle: reg }), { ok: false, error: "verb-not-permitted" });
  assert.deepEqual(authorize({ ...home, registryRole: "follower" }, { verb: "put", bundle: req }), { ok: true });
});

test("forced command quotes every argument and refuses shell metacharacters", () => {
  const cmd = forcedCommand({ node: "/usr/local/bin/node", receiver: "/opt/pns/plugins/paseo-node-sync/server/receiver/main.ts",
    stateRoot: "/home/lab/state dir/node-sync", peerId: "home" });
  assert.equal(cmd, "'/usr/local/bin/node' '/opt/pns/plugins/paseo-node-sync/server/receiver/main.ts' '--state-root' '/home/lab/state dir/node-sync' '--peer' 'home'");
  for (const bad of ["/x;id", "/x$(id)", "/x`id`", "/x'y", '/x"y', "/x\\y", "/x\ny", "relative/path", "/x&y", "/x|y", "/x>y"])
    assert.throws(() => forcedCommand({ node: "/usr/local/bin/node", receiver: "/r.ts", stateRoot: bad, peerId: "home" }), bad);
  assert.throws(() => forcedCommand({ node: "/usr/local/bin/node", receiver: "/r.ts", stateRoot: "/s", peerId: "Home;id" }));
});
