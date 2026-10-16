// Wire protocol between the sending worker and the forced-command receiver. Dependency-free and free of
// Node built-ins so the receiver runs before any npm install and the client can share the types.
import type { ItemState } from "./states.ts";

export const PROTOCOL_VERSION = 1;
export const CAPABILITIES = { skills: 1, config: 1, plugins: 1, registry: 1 } as const;
export type Category = "skills" | "config" | "plugins";
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const FRAME_MAGIC = "NSYNC1";
export const MAX_ITEMS = 5000;

export interface DesiredItem { key: string; category: Category; digest: string; payload: unknown }
export interface DataBundle {
  kind: "data"; protocol: number; capability: number; setId: string; incarnation: string;
  generation: number; complete: boolean; items: DesiredItem[]; tombstones: string[];
  released: string[]; digest: string;
}
export interface RegistryBundle { kind: "registry"; protocol: number; revision: number; registry: Registry; digest: string }
export interface RegistryRequestBundle { kind: "registry-request"; protocol: number; requestId: string; baseRevision: number; change: RegistryChange; digest: string }
export type Bundle = DataBundle | RegistryBundle | RegistryRequestBundle;

export type ReceiverRequest =
  | { verb: "put"; bundle: Bundle }
  | { verb: "fetch-result"; setId: string; incarnation: string; generation: number };
export type ReceiverResponse =
  | { ok: true; verb: "put"; status: "accepted" | "duplicate"; node?: NodeHello }
  | { ok: true; verb: "fetch-result"; status: "pending" | "done" | "unknown"; result?: GenerationResult; registry?: RegistryOutcome; node?: NodeHello }
  | { ok: false; error: RejectReason; detail: string; node?: NodeHello };
export type RejectReason = "bad-frame" | "bad-verb" | "bad-schema" | "unbound-peer" | "verb-not-permitted"
  | "set-not-admitted" | "direction-not-permitted" | "stale-incarnation" | "generation-conflict"
  | "oversize" | "protocol-unsupported" | "internal";
export interface NodeHello { nodeId: string; protocol: number; capabilities: Record<string, number> }
export interface ItemResult { key: string; state: ItemState; detail?: string; backupId?: string; desiredDigest?: string; actualDigest?: string }
// supersededBy: a newer generation arrived before this one was applied; only the newest is applied.
export interface GenerationResult { setId: string; incarnation: string; generation: number; status: "rejected" | "applied"; reason?: RejectReason;
  items: ItemResult[]; supersededBy?: number; at?: string }
// Owner-side outcome of a follower's registry-request, fetched by the follower over the "_registry" channel.
// requester: owner-side only (never sent), the authenticated peer that staged the request.
export interface RegistryOutcome { requestId: string; status: "applied" | "rejected"; revision?: number; error?: string; at: string; requester?: string }

export interface Registry { revision: number; ownerNodeId: string; sets: SetDefinition[] }
export interface SetDefinition { id: string; incarnation: string; source: string; destination: string;
  category: Category; items: EnrolledItem[]; createdAt: string }
export interface EnrolledItem { key: string; resource: string; options?: Record<string, unknown> }
export type RegistryChange =
  | { op: "create-set"; set: Omit<SetDefinition, "incarnation" | "createdAt"> }
  | { op: "delete-set"; setId: string }
  | { op: "enroll"; setId: string; item: EnrolledItem }
  | { op: "unenroll"; setId: string; key: string };

// Identifier grammar shared with server/paths.ts. "_hello" is the reserved connection-test set id.
export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const HELLO_SET = "_hello";
// Reserved fetch-result channel: incarnation carries a follower requestId, answered with its RegistryOutcome.
export const REGISTRY_SET = "_registry";
export const INCARNATION = /^[A-Za-z0-9_-]{8,64}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
const KEY = /^(skill|profile|setting|plugin):[A-Za-z0-9._@-][A-Za-z0-9._@/-]{0,199}$/;
const CATEGORIES = new Set(["skills", "config", "plugins"]);

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

// Frame: "NSYNC1\n<decimal length>\n<utf-8 JSON>". Uint8Array keeps this module free of Node built-ins.
export function encodeFrame(value: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(value));
  const head = enc.encode(`${FRAME_MAGIC}\n${body.length}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head); out.set(body, head.length);
  return out;
}

function indexOf(buf: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// A preamble (bytes a login shell prints before the forced command) is tolerated up to maxPreamble bytes.
export function decodeFrame(buf: Uint8Array, opts: { maxPreamble?: number } = {}):
  { value: unknown; rest: Uint8Array } | { need: true } | { error: "bad-frame" | "oversize" } {
  const maxPreamble = opts.maxPreamble ?? 0;
  const magic = enc.encode(`${FRAME_MAGIC}\n`);
  const start = indexOf(buf, magic);
  if (start < 0) return buf.length >= maxPreamble + magic.length ? { error: "bad-frame" } : { need: true };
  if (start > maxPreamble) return { error: "bad-frame" };
  const lenStart = start + magic.length;
  const lenEnd = buf.indexOf(0x0a, lenStart);
  if (lenEnd < 0) return buf.length - lenStart > 9 ? { error: "bad-frame" } : { need: true };
  const text = String.fromCharCode(...buf.subarray(lenStart, lenEnd));
  if (!/^\d{1,9}$/.test(text)) return { error: "bad-frame" };
  const len = Number(text);
  if (len > MAX_FRAME_BYTES) return { error: "oversize" };
  if (buf.length < lenEnd + 1 + len) return { need: true };
  try { return { value: JSON.parse(dec.decode(buf.subarray(lenEnd + 1, lenEnd + 1 + len))), rest: buf.subarray(lenEnd + 1 + len) }; }
  catch { return { error: "bad-frame" }; }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, allowed: string[], optional: string[] = []) =>
  allowed.every(k => k in o) && Object.keys(o).every(k => allowed.includes(k) || optional.includes(k));
const posInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
const nonNegInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
// Item ids may contain "/" (npm scopes, nested names) but never as a root, an empty segment, "." or "..".
export const validKey = (k: unknown) => typeof k === "string" && KEY.test(k) &&
  k.slice(k.indexOf(":") + 1).split("/").every(seg => seg !== "" && seg !== "." && seg !== "..");
const keyList = (v: unknown, max = MAX_ITEMS) => Array.isArray(v) && v.length <= max && v.every(validKey);
const str = (v: unknown, max = 200) => typeof v === "string" && v.length <= max;

function validItem(v: unknown): boolean {
  return isObj(v) && onlyKeys(v, ["key", "category", "digest", "payload"]) && validKey(v.key) &&
    CATEGORIES.has(v.category as string) && typeof v.digest === "string" && DIGEST.test(v.digest);
}
function validEnrolled(v: unknown): boolean {
  return isObj(v) && onlyKeys(v, ["key", "resource"], ["options"]) && validKey(v.key) && str(v.resource, 1024) &&
    (v.options === undefined || isObj(v.options));
}
function validSet(v: unknown): boolean {
  return isObj(v) && onlyKeys(v, ["id", "incarnation", "source", "destination", "category", "items", "createdAt"]) &&
    typeof v.id === "string" && ID.test(v.id) && typeof v.incarnation === "string" && INCARNATION.test(v.incarnation) &&
    typeof v.source === "string" && ID.test(v.source) && typeof v.destination === "string" && ID.test(v.destination) &&
    CATEGORIES.has(v.category as string) && Array.isArray(v.items) && v.items.length <= MAX_ITEMS && v.items.every(validEnrolled) && str(v.createdAt, 64);
}
function validChange(v: unknown): boolean {
  if (!isObj(v)) return false;
  const id = (x: unknown) => typeof x === "string" && ID.test(x);
  switch (v.op) {
    case "create-set": {
      const s = v.set;
      return onlyKeys(v, ["op", "set"]) && isObj(s) && onlyKeys(s, ["id", "source", "destination", "category", "items"]) &&
        id(s.id) && id(s.source) && id(s.destination) && CATEGORIES.has(s.category as string) &&
        Array.isArray(s.items) && s.items.length <= MAX_ITEMS && s.items.every(validEnrolled);
    }
    case "delete-set": return onlyKeys(v, ["op", "setId"]) && id(v.setId);
    case "enroll": return onlyKeys(v, ["op", "setId", "item"]) && id(v.setId) && validEnrolled(v.item);
    case "unenroll": return onlyKeys(v, ["op", "setId", "key"]) && id(v.setId) && validKey(v.key);
    default: return false;
  }
}

function validBundle(b: Obj): boolean {
  if (typeof b.digest !== "string" || !DIGEST.test(b.digest)) return false;
  switch (b.kind) {
    case "data":
      return onlyKeys(b, ["kind", "protocol", "capability", "setId", "incarnation", "generation", "complete", "items", "tombstones", "released", "digest"]) &&
        posInt(b.capability) && typeof b.setId === "string" && ID.test(b.setId) && typeof b.incarnation === "string" &&
        INCARNATION.test(b.incarnation) && posInt(b.generation) && typeof b.complete === "boolean" &&
        Array.isArray(b.items) && b.items.length <= MAX_ITEMS && b.items.every(validItem) && keyList(b.tombstones) && keyList(b.released);
    case "registry": {
      const r = b.registry;
      return onlyKeys(b, ["kind", "protocol", "revision", "registry", "digest"]) && nonNegInt(b.revision) && isObj(r) &&
        onlyKeys(r, ["revision", "ownerNodeId", "sets"]) && r.revision === b.revision && typeof r.ownerNodeId === "string" &&
        ID.test(r.ownerNodeId) && Array.isArray(r.sets) && r.sets.length <= 1000 && r.sets.every(validSet);
    }
    case "registry-request":
      return onlyKeys(b, ["kind", "protocol", "requestId", "baseRevision", "change", "digest"]) && typeof b.requestId === "string" &&
        ID.test(b.requestId) && nonNegInt(b.baseRevision) && validChange(b.change);
    default: return false;
  }
}

export function parseRequest(value: unknown): ReceiverRequest | { error: "bad-verb" | "bad-schema" | "protocol-unsupported" } {
  if (!isObj(value)) return { error: "bad-schema" };
  if (value.verb === "fetch-result") {
    const ok = onlyKeys(value, ["verb", "setId", "incarnation", "generation"]) && typeof value.setId === "string" &&
      (ID.test(value.setId) || value.setId === HELLO_SET || value.setId === REGISTRY_SET) && typeof value.incarnation === "string" &&
      INCARNATION.test(value.incarnation) && posInt(value.generation);
    return ok ? value as ReceiverRequest : { error: "bad-schema" };
  }
  if (value.verb !== "put") return { error: "bad-verb" };
  if (!onlyKeys(value, ["verb", "bundle"]) || !isObj(value.bundle)) return { error: "bad-schema" };
  const b = value.bundle;
  if (typeof b.protocol !== "number") return { error: "bad-schema" };
  if (b.protocol !== PROTOCOL_VERSION) return { error: "protocol-unsupported" };
  return validBundle(b) ? value as ReceiverRequest : { error: "bad-schema" };
}
