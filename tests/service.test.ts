import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../server/paths.ts";
import { NodeSyncService } from "../server/service.ts";
import { handleRequest } from "../server/receiver/handle.ts";
import type { Transport } from "../server/transport-ssh.ts";

const PUB = (n: string) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n.repeat(43)} pns-${n}`;

// In-process "network": a call to peer X runs X's real receiver logic against X's state root.
async function pair() {
  const homes = { a: await mkdtemp(`${tmpdir()}/pns-svc-a-`), b: await mkdtemp(`${tmpdir()}/pns-svc-b-`) };
  const paths = { a: nodePaths(homes.a), b: nodePaths(homes.b) };
  let offline = false;
  const transport = (self: "a" | "b"): Transport => ({ async call(peer, req) {
    if (offline) throw Object.assign(new Error("unreachable"), { kind: "unreachable" });
    const target = peer.peerId === "work" ? paths.b : paths.a;
    return handleRequest(target, self === "a" ? "home" : "work", req);
  } });
  const ids = { n: 0 };
  const mk = (self: "a" | "b") => new NodeSyncService({ paths: paths[self], transport: transport(self), now: () => "2026-10-16T00:00:00Z",
    newId: () => `id${self}${++ids.n}`.padEnd(12, "0") });
  return { homes, paths, a: mk("a"), b: mk("b"), setOffline: (v: boolean) => { offline = v; } };
}
const endpoint = { host: "127.0.0.1", port: 47011, user: "lab", keyPath: "/home/lab/keys/id_ed25519" };

async function enrolled() {
  const p = await pair();
  assert.deepEqual(await p.a.init({ nodeId: "home", role: "owner" }), { ok: true, node: { nodeId: "home", role: "owner" } });
  await p.b.init({ nodeId: "work", role: "follower" });
  await p.a.enroll({ peerId: "work", hostKey: PUB("B"), publicKey: PUB("b"), registryRole: "follower", endpoint });
  await p.b.enroll({ peerId: "home", hostKey: PUB("A"), publicKey: PUB("a"), registryRole: "owner", endpoint });
  return p;
}

test("node init is one-time and fixes the registry owner on the owner node", async () => {
  const p = await pair();
  assert.equal((await p.a.overview()).node, null);
  await p.a.init({ nodeId: "home", role: "owner" });
  assert.deepEqual(await p.a.init({ nodeId: "other", role: "owner" }), { ok: false, error: "already-initialized" });
  assert.equal((await p.a.overview()).registry.ownerNodeId, "home");
  await rm(p.homes.a, { recursive: true }); await rm(p.homes.b, { recursive: true });
});

test("connection test works both ways and returns the peer's hello", async () => {
  const p = await enrolled();
  const ab = await p.a.testPeer("work"), ba = await p.b.testPeer("home");
  assert.ok(ab.ok && ab.hello.nodeId === "work", JSON.stringify(ab));
  assert.ok(ba.ok && ba.hello.nodeId === "home", JSON.stringify(ba));
  assert.deepEqual(await p.a.testPeer("nobody"), { ok: false, error: "unknown-peer" });
  p.setOffline(true);
  assert.deepEqual(await p.a.testPeer("work"), { ok: false, error: "unreachable", detail: "unreachable" });
});

test("follower change is a request; it applies only after the owner's revision advances and replicates", async () => {
  const p = await enrolled();
  const req = await p.b.change({ op: "create-set", set: { id: "skills-home", source: "home", destination: "work", category: "skills", items: [] } });
  assert.equal(req.status, "requested");
  assert.equal((await p.b.overview()).registry.revision, 0, "follower registry unchanged by its own request");
  assert.equal((await p.a.overview()).registry.revision, 0, "owner applies only when it processes the request");
  await p.a.drain();
  assert.equal((await p.a.overview()).registry.revision, 1);
  assert.equal((await p.b.overview()).registry.revision, 0, "replicated but not yet drained on the follower");
  await p.b.drain();
  const ov = await p.b.overview();
  assert.equal(ov.registry.revision, 1);
  assert.deepEqual(ov.sets.map(s => [s.id, s.state]), [["skills-home", "not-admitted"]], "a received registry admits nothing");
  await p.b.admit({ peerId: "home", setId: "skills-home", direction: "inbound" });
  assert.deepEqual((await p.b.overview()).sets.map(s => [s.id, s.state]), [["skills-home", "idle"]]);
});

test("enrollment keeps only public material and validates it", async () => {
  const p = await pair();
  await p.a.init({ nodeId: "home", role: "owner" });
  const bad = (o: object) => p.a.enroll({ peerId: "work", hostKey: PUB("B"), publicKey: PUB("b"), registryRole: "follower", endpoint, ...o });
  assert.deepEqual(await bad({ publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }), { ok: false, error: "invalid-public-key" });
  assert.deepEqual(await bad({ hostKey: `${PUB("B")}\n${PUB("C")}` }), { ok: false, error: "invalid-host-key" });
  assert.deepEqual(await bad({ endpoint: { ...endpoint, keyPath: "relative/id" } }), { ok: false, error: "invalid-endpoint" });
  assert.deepEqual(await bad({ peerId: "../x" }), { ok: false, error: "invalid-peer-id" });
  assert.equal((await bad({})).ok, true);
  const peersFile = await readFile(p.paths.a.peers, "utf8");
  assert.ok(!peersFile.includes("PRIVATE"));
  assert.match(await readFile(`${p.paths.a.root}/peers/work/known_hosts`, "utf8"), /^\[127\.0\.0\.1\]:47011 ssh-ed25519 /);
  const listed = await p.a.listPeers();
  assert.deepEqual(Object.keys(listed[0]!).sort(), ["admittedAt", "endpoint", "fingerprint", "hostKeyFingerprint", "peerId", "registryRole", "sets", "verbs"]);
});
