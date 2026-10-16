// A registry request's outcome belongs to the authenticated peer that staged it (the receiver's --peer), never to
// whoever later presents the same requestId; ownership survives processing and restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../server/paths.ts";
import { NodeSyncService } from "../server/service.ts";
import { handleRequest } from "../server/receiver/handle.ts";
import { readRequestOwners, stageRegistry } from "../server/inbox.ts";
import { bundleDigest } from "../server/canonical.ts";
import { TransportError, type Transport } from "../server/transport-ssh.ts";
import { PROTOCOL_VERSION, REGISTRY_SET, parseRequest, type RegistryChange, type RegistryRequestBundle } from "../shared/protocol.ts";

const PUB = (n: string) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n.repeat(43)} pns-${n}`;
const offline: Transport = { async call() { throw new TransportError("unreachable", "test: followers are not reachable"); } };
const create = (id: string): RegistryChange => ({ op: "create-set", set: { id, source: "home", destination: "work", category: "skills", items: [] } });
function request(requestId: string, change: RegistryChange): RegistryRequestBundle {
  const body = { kind: "registry-request" as const, protocol: PROTOCOL_VERSION, requestId, baseRevision: 0, change };
  return { ...body, digest: bundleDigest(body) };
}

test("two followers: outcomes go only to the requester; a reused requestId is a conflict, a retry stays a duplicate", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-regown-`);
  try {
    const paths = nodePaths(home);
    const owner = new NodeSyncService({ paths, transport: offline });
    await owner.init({ nodeId: "home", role: "owner" });
    await owner.enroll({ peerId: "work", hostKey: PUB("W"), publicKey: PUB("w"), registryRole: "follower" });
    await owner.enroll({ peerId: "lab2", hostKey: PUB("L"), publicKey: PUB("l"), registryRole: "follower" });
    const put = (peer: string, b: RegistryRequestBundle) => handleRequest(paths, peer, { verb: "put", bundle: b });
    const fetch = (peer: string, id: string) => handleRequest(paths, peer, { verb: "fetch-result", setId: REGISTRY_SET, incarnation: id, generation: 1 });

    const r1 = request("req-00001", create("s1"));
    assert.equal((await put("work", r1) as { status?: string }).status, "accepted");
    assert.equal((await put("lab2", r1) as { error?: string }).error, "generation-conflict", "same id and digest from another peer");
    assert.equal((await put("lab2", request("req-00001", create("s2")))).ok, false, "same id, different digest");
    await owner.drain();

    const mine = await fetch("work", "req-00001");
    assert.equal(mine.ok && mine.verb === "fetch-result" && mine.status, "done");
    assert.equal(mine.ok && mine.verb === "fetch-result" && mine.registry?.status, "applied");
    assert.equal(mine.ok && mine.verb === "fetch-result" && "requester" in (mine.registry ?? {}), false, "the requester binding is not sent");
    const theirs = await fetch("lab2", "req-00001");
    assert.deepEqual(theirs.ok && theirs.verb === "fetch-result" && [theirs.status, theirs.registry], ["unknown", undefined]);

    // A retry after processing is a duplicate and is not processed again.
    const before = (await owner.stores.registryResults.read()).value["req-00001"];
    assert.equal((await put("work", r1) as { status?: string }).status, "duplicate");
    assert.deepEqual((await readdir(paths.registryInbox)).filter(f => f.startsWith("request-") && f.endsWith(".json")), []);
    assert.deepEqual((await owner.drain()).processed, []);
    // Across a restart of the owner's service, ownership and the outcome are unchanged.
    const restarted = new NodeSyncService({ paths, transport: offline });
    await restarted.drain();
    assert.deepEqual((await restarted.stores.registryResults.read()).value["req-00001"], before);
    assert.equal((await fetch("work", "req-00001") as { status?: string }).status, "done");

    // lab2's own request is lab2's; the requester comes from the authenticated peer, the bundle names nobody.
    await put("lab2", request("req-00002", create("s3")));
    await restarted.drain();
    assert.equal((await fetch("lab2", "req-00002") as { status?: string }).status, "done");
    assert.equal((await fetch("work", "req-00002") as { status?: string }).status, "unknown");

    // An outcome without a recorded requester (written before ownership existed) is answered to nobody.
    await owner.stores.registryResults.update(all => ({ ...all, "req-legacy1": { requestId: "req-legacy1", status: "applied", revision: 1, at: "t" } }));
    for (const peer of ["work", "lab2"]) assert.equal((await fetch(peer, "req-legacy1") as { status?: string }).status, "unknown");
    // ...and its requestId cannot be claimed by anyone.
    assert.equal((await put("work", request("req-legacy1", create("s9"))) as { error?: string }).error, "generation-conflict");
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function ownerNode() {
  const home = await mkdtemp(`${tmpdir()}/pns-regown-`);
  const paths = nodePaths(home);
  const owner = new NodeSyncService({ paths, transport: offline });
  await owner.init({ nodeId: "home", role: "owner" });
  await owner.enroll({ peerId: "work", hostKey: PUB("W"), publicKey: PUB("w"), registryRole: "follower" });
  await owner.enroll({ peerId: "lab2", hostKey: PUB("L"), publicKey: PUB("l"), registryRole: "follower" });
  const put = async (peer: string, b: RegistryRequestBundle) => (await handleRequest(paths, peer, { verb: "put", bundle: b })) as { ok: boolean; status?: string; error?: string };
  const fetch = async (peer: string, id: string) => (await handleRequest(paths, peer, { verb: "fetch-result", setId: REGISTRY_SET, incarnation: id, generation: 1 })) as
    { status?: string; registry?: { status: string; revision?: number } };
  const staged = async () => (await readdir(paths.registryInbox)).filter(f => f.startsWith("request-"));
  return { home, paths, owner, put, fetch, staged };
}

test("a crash between the owner reservation and the staged file is repaired by the same peer's retry, exactly once", async () => {
  const n = await ownerNode();
  try {
    const r1 = request("req-crash01", create("s1"));
    for (const req of [{ verb: "put", bundle: r1 }, { verb: "fetch-result", setId: REGISTRY_SET, incarnation: r1.requestId, generation: 1 }])
      assert.equal("error" in parseRequest(req), false, "the test ids and bundles are valid on the wire");
    await assert.rejects(stageRegistry(n.paths, r1, "work", { afterOwners() { throw new Error("simulated crash after owners.json"); } }), /simulated crash/);
    const reservation = (await readRequestOwners(n.paths))["req-crash01"];
    assert.deepEqual(reservation, { peer: "work", digest: r1.digest });
    assert.deepEqual(await n.staged(), [], "only the reservation is durable");
    assert.deepEqual((await n.owner.drain()).processed, [], "nothing to drain yet");

    // Nobody else can use the reservation, before or after the repair.
    assert.equal((await n.put("lab2", r1)).error, "generation-conflict");
    assert.equal((await n.put("work", request("req-crash01", create("s2")))).error, "generation-conflict");
    assert.deepEqual(await n.staged(), []);

    // The owner restarts; the follower retries the same bundle.
    const restarted = new NodeSyncService({ paths: n.paths, transport: offline });
    assert.equal((await n.put("work", r1)).status, "accepted", "the missing staged file is written under the same reservation");
    assert.deepEqual((await readRequestOwners(n.paths))["req-crash01"], reservation, "the reservation is unchanged");
    assert.equal((await n.put("work", r1)).status, "duplicate");
    assert.deepEqual((await restarted.drain()).processed, ["request-req-crash01.json:applied"]);
    const revision = (await restarted.registry.read()).value.revision;
    const outcome = await n.fetch("work", "req-crash01");
    assert.deepEqual([outcome.status, outcome.registry?.status, outcome.registry?.revision], ["done", "applied", revision]);
    assert.equal((await n.fetch("lab2", "req-crash01")).status, "unknown");

    // Retries after processing stay duplicates: nothing is staged or applied again.
    assert.equal((await n.put("work", r1)).status, "duplicate");
    assert.deepEqual(await n.staged(), []);
    assert.deepEqual((await restarted.drain()).processed, []);
    assert.equal((await restarted.registry.read()).value.revision, revision);
    assert.equal((await n.put("lab2", r1)).error, "generation-conflict");
  } finally { await rm(n.home, { recursive: true, force: true }); }
});

test("a reserved request is a duplicate only when the evidence verifies; otherwise it fails closed", async () => {
  const n = await ownerNode();
  try {
    // Staged copy that is not this request (tampered): conflict, not duplicate.
    const r2 = request("req-tamper1", create("s2"));
    assert.equal((await n.put("work", r2)).status, "accepted");
    await writeFile(`${n.paths.registryInbox}/request-req-tamper1.json`, JSON.stringify({ ...r2, digest: "sha256:other" }));
    assert.equal((await n.put("work", r2)).error, "generation-conflict");

    // Staged file gone and a processed file with a matching name but other content: conflict, nothing restaged.
    const r3 = request("req-prefix1", create("s3"));
    await assert.rejects(stageRegistry(n.paths, r3, "work", { afterOwners() { throw new Error("simulated crash"); } }));
    await mkdir(`${n.paths.registryInbox}/processed`, { recursive: true });
    await writeFile(`${n.paths.registryInbox}/processed/request-req-prefix1.applied.json`, JSON.stringify({ kind: "registry-request", requestId: "req-other01", digest: r3.digest }));
    assert.equal((await n.put("work", r3)).error, "generation-conflict");
    assert.ok(!(await n.staged()).includes("request-req-prefix1.json"));

    // A verified processed copy with no outcome (e.g. drained while not owner): duplicate, nothing restaged.
    const r4 = request("req-procd01", create("s4"));
    await assert.rejects(stageRegistry(n.paths, r4, "work", { afterOwners() { throw new Error("simulated crash"); } }));
    await writeFile(`${n.paths.registryInbox}/processed/request-req-procd01.ignored-not-owner.json`, JSON.stringify(r4));
    assert.equal((await n.put("work", r4)).status, "duplicate");
    assert.ok(!(await n.staged()).includes("request-req-procd01.json"));
  } finally { await rm(n.home, { recursive: true, force: true }); }
});
