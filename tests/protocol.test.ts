import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, decodeFrame, parseRequest, PROTOCOL_VERSION, MAX_FRAME_BYTES } from "../shared/protocol.ts";
import { bundle, hex } from "./helpers.ts";

test("frame round-trips and tolerates a bounded shell preamble", () => {
  const frame = encodeFrame({ verb: "fetch-result", setId: "s1", incarnation: "incarnation-1", generation: 1 });
  const decoded = decodeFrame(Buffer.concat([Buffer.from("Last login: x\n"), frame]), { maxPreamble: 4096 });
  assert.ok("value" in decoded);
  assert.deepEqual(decoded.value, { verb: "fetch-result", setId: "s1", incarnation: "incarnation-1", generation: 1 });
  assert.deepEqual(decodeFrame(Buffer.concat([Buffer.from("x".repeat(64)), frame]), { maxPreamble: 8 }), { error: "bad-frame" });
});

test("partial frames ask for more; oversize and malformed lengths are rejected before the body", () => {
  const frame = encodeFrame({ a: 1 });
  assert.deepEqual(decodeFrame(frame.subarray(0, frame.length - 1)), { need: true });
  assert.deepEqual(decodeFrame(Buffer.from(`NSYNC1\n${MAX_FRAME_BYTES + 1}\n{`)), { error: "oversize" });
  assert.deepEqual(decodeFrame(Buffer.from("NSYNC1\n-5\n{}")), { error: "bad-frame" });
  assert.deepEqual(decodeFrame(Buffer.from("NSYNC1\n2\n{x")), { error: "bad-frame" });
});

test("unknown verbs, malformed requests and path-like ids are rejected", () => {
  assert.deepEqual(parseRequest({ verb: "exec", cmd: "id" }), { error: "bad-verb" });
  assert.deepEqual(parseRequest(null), { error: "bad-schema" });
  assert.deepEqual(parseRequest({ verb: "put" }), { error: "bad-schema" });
  assert.deepEqual(parseRequest({ verb: "put", bundle: { kind: "data", protocol: PROTOCOL_VERSION + 1 } }), { error: "protocol-unsupported" });
  for (const setId of ["../x", "a/b", "A", "x".repeat(64), ""])
    assert.deepEqual(parseRequest({ verb: "fetch-result", setId, incarnation: "incarnation-1", generation: 1 }), { error: "bad-schema" }, setId);
  assert.deepEqual(parseRequest({ verb: "fetch-result", setId: "s1", incarnation: "short", generation: 1 }), { error: "bad-schema" });
  assert.deepEqual(parseRequest({ verb: "fetch-result", setId: "s1", incarnation: "incarnation-1", generation: 0 }), { error: "bad-schema" });
});

test("data bundles validate keys, digests and extra fields", () => {
  const ok = bundle(1, [{ key: "skill:alpha", category: "skills", digest: hex("a"), payload: { x: 1 } }]);
  assert.equal("error" in parseRequest({ verb: "put", bundle: ok }), false);
  const bad = (b: unknown) => parseRequest({ verb: "put", bundle: b });
  assert.deepEqual(bad({ ...ok, items: [{ key: "skill:../etc", category: "skills", digest: hex("a"), payload: {} }] }), { error: "bad-schema" });
  assert.deepEqual(bad({ ...ok, items: [{ key: "skill:a", category: "secrets", digest: hex("a"), payload: {} }] }), { error: "bad-schema" });
  assert.deepEqual(bad({ ...ok, items: [{ key: "skill:a", category: "skills", digest: "sha256:0", payload: {} }] }), { error: "bad-schema" });
  for (const key of ["profile:/abs", "skill:a//b", "skill:a/./b", "skill:a/", "plugin:..", "setting:"])
    assert.deepEqual(bad({ ...ok, tombstones: [key] }), { error: "bad-schema" }, key);
  assert.equal("error" in bad({ ...ok, tombstones: ["plugin:@scope/name", "setting:mcp.injectIntoAgents"] }), false);
  assert.deepEqual(bad({ ...ok, complete: "yes" }), { error: "bad-schema" });
  assert.deepEqual(bad({ ...ok, extra: 1 }), { error: "bad-schema" });
});
