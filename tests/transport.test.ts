import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { sshTransport, sshArgv, TransportError } from "../server/transport-ssh.ts";
import { encodeFrame } from "../shared/protocol.ts";

type Fake = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(sig?: string): boolean; killed: string | null };
function fakeSpawn(stdout: Uint8Array, code: number | null, stderr = "", seen: { argv?: string[]; child?: Fake } = {}) {
  return ((_cmd: string, argv: string[]) => {
    const c = new EventEmitter() as Fake;
    c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.killed = null;
    c.kill = sig => { c.killed = sig ?? "SIGTERM"; setImmediate(() => c.emit("close", null)); return true; };
    seen.argv = argv; seen.child = c;
    if (code !== null) setImmediate(() => { c.stdout.end(Buffer.from(stdout)); c.stderr.end(stderr); c.emit("close", code); });
    return c;
  }) as never;
}
const peer = { peerId: "work", host: "127.0.0.1", port: 47011, user: "lab", key: "/k/id", knownHosts: "/kh" };
const hello = { verb: "fetch-result" as const, setId: "_hello", incarnation: "connection-test", generation: 1 };

test("decodes a response after a login-shell preamble and sends a framed request", async () => {
  const seen: { argv?: string[] } = {};
  const t = sshTransport({ spawn: fakeSpawn(Buffer.concat([Buffer.from("motd\n"), Buffer.from(encodeFrame({ ok: false, error: "bad-verb", detail: "" }))]), 0, "", seen) });
  assert.deepEqual(await t.call(peer, hello), { ok: false, error: "bad-verb", detail: "" });
  assert.deepEqual(seen.argv, sshArgv(peer));
});

test("errors are classified: host key, unreachable, bad frame, timeout kills only the child", async () => {
  const kind = async (spawn: never, timeoutMs?: number) => {
    try { await sshTransport({ spawn }).call(peer, hello, timeoutMs); return "none"; } catch (e) { return e instanceof TransportError ? e.kind : String(e); }
  };
  assert.equal(await kind(fakeSpawn(new Uint8Array(), 255, "Host key verification failed.")), "host-key");
  assert.equal(await kind(fakeSpawn(new Uint8Array(), 255, "ssh: connect to host 127.0.0.1 port 1: Connection refused")), "unreachable");
  assert.equal(await kind(fakeSpawn(Buffer.from("garbage"), 0)), "bad-frame");
  const seen: { child?: Fake } = {};
  assert.equal(await kind(fakeSpawn(new Uint8Array(), null, "", seen), 50), "timeout");
  assert.equal(seen.child!.killed, "SIGKILL");
});

test("ssh argv pins the host key, disables agent, config and forwarding, and validates the endpoint", () => {
  const argv = sshArgv(peer);
  assert.deepEqual(argv.slice(0, 2), ["-F", "/dev/null"]);
  for (const o of ["StrictHostKeyChecking=yes", "BatchMode=yes", "UserKnownHostsFile=/kh", "GlobalKnownHostsFile=/dev/null",
    "IdentitiesOnly=yes", "IdentityAgent=none", "ForwardAgent=no", "ClearAllForwardings=yes", "RequestTTY=no"]) assert.ok(argv.includes(o), o);
  assert.deepEqual(argv.slice(-2), ["lab@127.0.0.1", "node-sync"]);
  for (const bad of [{ host: "-oProxyCommand=x" }, { host: "a b" }, { port: 0 }, { user: "root;id" }, { key: "relative" }, { knownHosts: "/x\ny" }])
    assert.throws(() => sshArgv({ ...peer, ...bad }), JSON.stringify(bad));
});
