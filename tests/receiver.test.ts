import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { encodeFrame, decodeFrame } from "../shared/protocol.ts";
import { bundle, hex, INC } from "./helpers.ts";

const receiver = new URL("../server/receiver/main.ts", import.meta.url).pathname;

async function call(stateRoot: string, peer: string, input: Buffer | unknown) {
  const child = spawn(process.execPath, [receiver, "--state-root", stateRoot, "--peer", peer],
    { env: { PATH: "/usr/bin:/bin", SSH_ORIGINAL_COMMAND: "rm -rf /" } });
  const chunks: Buffer[] = [];
  child.stdout.on("data", c => chunks.push(c));
  child.stdin.end(Buffer.isBuffer(input) ? input : encodeFrame(input));
  const code = await new Promise<number>(r => child.on("close", r));
  const decoded = decodeFrame(Buffer.concat(chunks));
  assert.ok("value" in decoded, `no frame, exit ${code}`);
  return { code, response: decoded.value as { ok: boolean; error?: string; status?: string; node?: { nodeId: string } } };
}

async function state() {
  const root = await mkdtemp(`${tmpdir()}/pns-recv-`);
  await writeFile(`${root}/node.json`, JSON.stringify({ revision: 1, value: { nodeId: "work" } }));
  await writeFile(`${root}/peers.json`, JSON.stringify({ revision: 1, value: [{ peerId: "home", hostKey: "h",
    publicKey: "k", verbs: ["put", "fetch-result"], sets: [{ setId: "skills-home", direction: "inbound" }],
    registryRole: "owner", admittedAt: "2026-10-15T00:00:00Z" }] }));
  await writeFile(`${root}/registry.json`, JSON.stringify({ revision: 1, value: { revision: 1, ownerNodeId: "home",
    sets: [{ id: "skills-home", incarnation: INC, source: "home", destination: "work", category: "skills", items: [], createdAt: "x" },
      { id: "skills-other", incarnation: INC, source: "home", destination: "work", category: "skills", items: [], createdAt: "x" }] } }));
  return root;
}

test("receiver enforces verbs, bindings and admitted sets", async () => {
  const root = await state();
  assert.equal((await call(root, "home", { verb: "shell", cmd: "id" })).response.error, "bad-verb");
  assert.equal((await call(root, "stranger", { verb: "fetch-result", setId: "skills-home", incarnation: INC, generation: 1 })).response.error, "unbound-peer");
  assert.equal((await call(root, "home", { verb: "fetch-result", setId: "other-set", incarnation: INC, generation: 1 })).response.error, "set-not-admitted");
  // Named in the registry but not admitted in the local binding: still rejected.
  assert.equal((await call(root, "home", { verb: "put", bundle: bundle(1, [], { setId: "skills-other" }) })).response.error, "set-not-admitted");
  const ok = await call(root, "home", { verb: "fetch-result", setId: "skills-home", incarnation: INC, generation: 1 });
  assert.equal(ok.code, 0);
  assert.equal(ok.response.ok, true);
  assert.equal(ok.response.node?.nodeId, "work");
  await rm(root, { recursive: true });
});

test("put stages once, duplicates are idempotent, stale incarnations are rejected; log has no payload", async () => {
  const root = await state();
  const secret = "SENTINEL-PAYLOAD-DO-NOT-LOG";
  const b = bundle(1, [{ key: "skill:alpha", category: "skills", digest: hex("c"), payload: { text: secret } }]);
  assert.equal((await call(root, "home", { verb: "put", bundle: b })).response.status, "accepted");
  assert.equal((await call(root, "home", { verb: "put", bundle: b })).response.status, "duplicate");
  assert.equal((await call(root, "home", { verb: "put", bundle: bundle(2, [], { incarnation: "incarnation-0" }) })).response.error, "stale-incarnation");
  assert.equal((await call(root, "home", { verb: "fetch-result", setId: "skills-home", incarnation: INC, generation: 1 })).response.status, "pending");
  const log = await readFile(`${root}/log/receiver.log`, "utf8");
  assert.ok(!log.includes(secret));
  assert.ok(!log.includes("rm -rf"));
  assert.match(log, /"originalCommandBytes":8/);
  assert.equal(log.trim().split("\n").length, 4);
  await rm(root, { recursive: true });
});

test("malformed input gets a framed rejection, never a crash", async () => {
  const root = await state();
  const garbage = await call(root, "home", Buffer.from("not a frame at all\n"));
  assert.equal(garbage.response.error, "bad-frame");
  assert.equal(garbage.code, 0);
  assert.equal((await call(root, "home", Buffer.from(`NSYNC1\n${17 * 1024 * 1024}\n{`))).response.error, "oversize");
  assert.equal((await call(root, "home", Buffer.from("NSYNC1\n100\n{\"verb\""))).response.error, "bad-frame");
  await rm(root, { recursive: true });
});
