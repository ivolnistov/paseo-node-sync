import { createHash } from "node:crypto";

// Sorted keys, no whitespace. Values JSON.stringify would drop or mangle are errors, so two nodes can
// never disagree about what was hashed.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.keys(v as object).sort().map(k => {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) throw new Error(`canonicalJson: undefined at ${k}`);
      return `${JSON.stringify(k)}:${canonicalJson(x)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v}`);
}

export function digestBytes(b: Uint8Array): string {
  return `sha256:${createHash("sha256").update(b).digest("hex")}`;
}

export function digest(v: unknown): string {
  return digestBytes(Buffer.from(canonicalJson(v), "utf8"));
}

// A bundle's digest covers every field except `digest` itself. The property is omitted, not set to
// undefined: canonicalJson rejects undefined by design.
export function bundleDigest(b: object): string {
  const { digest: _omit, ...rest } = b as Record<string, unknown>;
  return digest(rest);
}

// File-system-safe name for an item key: hash prefix for uniqueness plus a readable tail.
export function safeName(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${hash}-${key.replace(/[^A-Za-z0-9._-]/g, "_").slice(-48)}`;
}
