import { createHash } from "node:crypto";
import { ID, HELLO_SET, REGISTRY_SET, type ReceiverRequest, type RejectReason } from "../shared/protocol.ts";
import type { DocStore } from "./store.ts";

// Locally granted trust for one remote node. A received registry never changes this; only a local
// operator action does (Task 3).
// How this node reaches the peer. Only a path to the private key is stored, never key material.
export interface PeerEndpointConfig { host: string; port: number; user: string; keyPath: string }
export interface PeerBinding { peerId: string; hostKey: string; publicKey: string;
  verbs: ("put" | "fetch-result")[]; sets: { setId: string; direction: "inbound" | "outbound" }[];
  registryRole: "owner" | "follower" | "none"; admittedAt: string; endpoint?: PeerEndpointConfig }

export function resolveBinding(bindings: PeerBinding[], peerArg: string): PeerBinding | null {
  return bindings.find(b => b.peerId === peerArg) ?? null;
}

function setAccess(b: PeerBinding, setId: string): { ok: true } | { ok: false; error: RejectReason } {
  const s = b.sets.find(x => x.setId === setId);
  if (!s) return { ok: false, error: "set-not-admitted" };
  // "outbound" means this node is the set's source; the peer may neither push to it nor fetch its results here.
  if (s.direction !== "inbound") return { ok: false, error: "direction-not-permitted" };
  return { ok: true };
}

// Human-readable reason for a rejection, so an operator can tell a role mistake from a missing admission.
export function rejectDetail(b: PeerBinding | null, req: ReceiverRequest, error: RejectReason): string {
  if (error === "unbound-peer") return "no local binding for this peer";
  if (req.verb === "put" && req.bundle.kind === "registry" && error === "verb-not-permitted")
    return `registry snapshots are accepted only from the registry owner; this binding's role is "${b?.registryRole}"`;
  if (req.verb === "put" && req.bundle.kind === "registry-request" && error === "verb-not-permitted")
    return `registry change requests are accepted only from a follower; this binding's role is "${b?.registryRole}"`;
  if (error === "verb-not-permitted") return `verb "${req.verb}" is not permitted for this peer`;
  if (error === "set-not-admitted") return "set not admitted for this peer on this node";
  if (error === "direction-not-permitted") return "this node is the source of the set";
  return "not authorized by local peer binding";
}

export function authorize(b: PeerBinding | null, req: ReceiverRequest): { ok: true } | { ok: false; error: RejectReason } {
  if (!b) return { ok: false, error: "unbound-peer" };
  if (!b.verbs.includes(req.verb)) return { ok: false, error: "verb-not-permitted" };
  if (req.verb === "fetch-result") {
    if (req.setId === HELLO_SET) return { ok: true };
    // Registry outcomes are answered only to a follower asking the owner about its own requests.
    if (req.setId === REGISTRY_SET) return b.registryRole === "follower" ? { ok: true } : { ok: false, error: "verb-not-permitted" };
    return setAccess(b, req.setId);
  }
  const bundle = req.bundle;
  if (bundle.kind === "registry") return b.registryRole === "owner" ? { ok: true } : { ok: false, error: "verb-not-permitted" };
  if (bundle.kind === "registry-request") return b.registryRole === "follower" ? { ok: true } : { ok: false, error: "verb-not-permitted" };
  return setAccess(b, bundle.setId);
}

// Absolute paths from a conservative alphabet (spaces allowed): no quotes, $, backticks, backslashes,
// globs, ;&|<> or control characters, so single-quoting each argument is a complete escape.
const SAFE_PATH = /^\/[A-Za-z0-9 ._\/+@%:=,~-]*$/;

// The fixed command placed in authorized_keys `command="..."`. sshd runs it through the account shell,
// so every argument is single-quoted and nothing from the connection is ever interpolated.
export function forcedCommand(o: { node: string; receiver: string; stateRoot: string; peerId: string }): string {
  for (const [name, v] of [["node", o.node], ["receiver", o.receiver], ["stateRoot", o.stateRoot]] as const)
    if (!SAFE_PATH.test(v) || v.includes("/../") || v.endsWith("/..")) throw new Error(`unsafe ${name} path: ${JSON.stringify(v)}`);
  if (!ID.test(o.peerId)) throw new Error(`invalid peer id: ${JSON.stringify(o.peerId)}`);
  return [o.node, o.receiver, "--state-root", o.stateRoot, "--peer", o.peerId].map(a => `'${a}'`).join(" ");
}

// Public OpenSSH ed25519 key on one line, optional comment. Anything else (private keys, multiple lines) is refused.
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{60,80}={0,2}(?: [ -~]{0,200})?$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]{2,39})$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const KEY_PATH = /^\/[A-Za-z0-9 ._\/+@%:=,~-]{1,1024}$/;

export const validPublicKey = (k: unknown): k is string => typeof k === "string" && PUBLIC_KEY.test(k) && !/PRIVATE/i.test(k);
export function validEndpoint(e: unknown): e is PeerEndpointConfig {
  const x = e as PeerEndpointConfig;
  return !!x && typeof x === "object" && typeof x.host === "string" && HOST.test(x.host) && Number.isInteger(x.port) && x.port >= 1 &&
    x.port <= 65535 && typeof x.user === "string" && USER.test(x.user) && typeof x.keyPath === "string" && KEY_PATH.test(x.keyPath) &&
    !x.keyPath.split("/").includes("..");
}

// SHA256 fingerprint in OpenSSH notation, for display instead of the key.
export function fingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.split(" ")[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export type EnrollInput = { peerId: string; hostKey: string; publicKey: string; registryRole: PeerBinding["registryRole"]; endpoint?: PeerEndpointConfig };
export type EnrollError = "invalid-peer-id" | "invalid-host-key" | "invalid-public-key" | "invalid-endpoint" | "invalid-role";

// Local operator action. Re-enrolling an existing peer re-pins its keys and endpoint but keeps its admissions.
export async function enrollPeer(store: DocStore<PeerBinding[]>, input: EnrollInput, now: string):
  Promise<{ ok: true; binding: PeerBinding } | { ok: false; error: EnrollError }> {
  if (typeof input.peerId !== "string" || !ID.test(input.peerId)) return { ok: false, error: "invalid-peer-id" };
  if (!validPublicKey(input.hostKey)) return { ok: false, error: "invalid-host-key" };
  if (!validPublicKey(input.publicKey)) return { ok: false, error: "invalid-public-key" };
  if (input.endpoint !== undefined && !validEndpoint(input.endpoint)) return { ok: false, error: "invalid-endpoint" };
  if (!["owner", "follower", "none"].includes(input.registryRole)) return { ok: false, error: "invalid-role" };
  let binding: PeerBinding | null = null;
  await store.update(list => {
    const prior = list.find(b => b.peerId === input.peerId);
    binding = { peerId: input.peerId, hostKey: input.hostKey, publicKey: input.publicKey, verbs: ["put", "fetch-result"],
      sets: prior?.sets ?? [], registryRole: input.registryRole, admittedAt: prior?.admittedAt ?? now,
      ...(input.endpoint ? { endpoint: { ...input.endpoint } } : {}) };
    return [...list.filter(b => b.peerId !== input.peerId), binding];
  });
  return { ok: true, binding: binding! };
}

// Local admission of one set for one peer. A received registry never calls this.
export async function admitSet(store: DocStore<PeerBinding[]>, peerId: string, setId: string, direction: "inbound" | "outbound"):
  Promise<{ ok: true } | { ok: false; error: "unknown-peer" | "invalid-set-id" | "invalid-direction" }> {
  if (!ID.test(setId)) return { ok: false, error: "invalid-set-id" };
  if (direction !== "inbound" && direction !== "outbound") return { ok: false, error: "invalid-direction" };
  let found = false;
  await store.update(list => list.map(b => {
    if (b.peerId !== peerId) return b;
    found = true;
    return { ...b, sets: [...b.sets.filter(s => s.setId !== setId), { setId, direction }] };
  }));
  return found ? { ok: true } : { ok: false, error: "unknown-peer" };
}
