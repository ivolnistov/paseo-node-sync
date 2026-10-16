import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, digest, bundleDigest } from "../server/canonical.ts";

test("canonical JSON sorts keys and rejects values JSON would silently drop or mangle", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 2 }] }), '{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  for (const v of [{ a: undefined }, { a: () => 1 }, { a: Infinity }, { a: NaN }, [undefined]]) assert.throws(() => canonicalJson(v));
});

test("bundle digest omits the digest property instead of setting it to undefined", () => {
  const b = { kind: "data", generation: 1 };
  assert.equal(bundleDigest({ ...b, digest: "sha256:whatever" }), bundleDigest(b));
  assert.match(bundleDigest(b), /^sha256:[0-9a-f]{64}$/);
});
