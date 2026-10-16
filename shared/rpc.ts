// RPC contracts between the Node sync screen and the daemon-side worker. Shared by client and server; no Node built-ins.
// Method names must match ^[a-z][a-z0-9._-]*$ (plugin host rule), hence "node-sync.*".
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const role = z.enum(["owner", "follower"]);
const peerRole = z.enum(["owner", "follower", "none"]);
const endpoint = z.object({ host: z.string().max(253), port: z.number().int(), user: z.string().max(32), keyPath: z.string().max(1024) });
export const SESSION_STATES = ["starting", "connected", "endpoint-unknown", "endpoint-unsupported", "auth-required", "unreachable", "stopped"] as const;
const sessionStatus = z.object({ state: z.enum(SESSION_STATES), detail: z.string().optional(), since: z.string(), attempts: z.number() });
const failure = z.object({ ok: z.literal(false), error: z.string(), detail: z.string().optional() });
const hello = z.object({ nodeId: z.string(), protocol: z.number(), capabilities: z.record(z.string(), z.number()) });
const peer = z.object({ peerId: z.string(), registryRole: peerRole, verbs: z.array(z.string()),
  sets: z.array(z.object({ setId: z.string(), direction: z.enum(["inbound", "outbound"]) })), admittedAt: z.string(),
  endpoint: endpoint.nullable(), fingerprint: z.string(), hostKeyFingerprint: z.string() });
const item = z.object({ key: z.string(), resource: z.string(), options: z.record(z.string(), z.unknown()).optional() });
const category = z.enum(["skills", "config", "plugins"]);

export const overviewRpc = defineRpc({ name: "node-sync.overview", input: z.object({}),
  output: z.object({
    node: z.object({ nodeId: z.string(), role }).nullable(),
    registry: z.object({ revision: z.number(), ownerNodeId: z.string() }),
    sets: z.array(z.object({ id: z.string(), category: z.string(), source: z.string(), destination: z.string(), items: z.number(),
      state: z.string(), pendingGeneration: z.number().nullable(), lastResultAt: z.string().nullable() })),
    peers: z.number(),
    replication: z.array(z.object({ peerId: z.string(), acked: z.number(), attempts: z.number(), lastError: z.string().optional() })).max(10),
    requests: z.array(z.object({ requestId: z.string(), summary: z.string(), status: z.enum(["requested", "applied", "rejected"]),
      error: z.string().optional(), revision: z.number().optional() })).max(20),
    runtime: z.array(z.object({ setId: z.string(), side: z.enum(["source", "destination"]), state: z.string(), detail: z.string().optional(),
      generation: z.number(), paused: z.boolean(), delivery: z.object({ state: z.string(), detail: z.string() }).optional() })).max(100),
    session: sessionStatus, sessionAttached: z.boolean(),
    // recoveryPending/holds are optional so an older worker's answer still parses.
    worker: z.object({ lastError: z.string().nullable(), recoveryPending: z.boolean().optional(),
      holds: z.array(z.object({ file: z.string(), scope: z.enum(["node", "set"]), setId: z.string().optional(), reason: z.string(), at: z.string() })).max(20).optional() }),
  }) });
export const nodeInitRpc = defineRpc({ name: "node-sync.node.init", input: z.object({ nodeId: id, role }),
  output: z.union([z.object({ ok: z.literal(true), node: z.object({ nodeId: z.string(), role }) }), failure]) });
export const peerListRpc = defineRpc({ name: "node-sync.peer.list", input: z.object({}), output: z.object({ peers: z.array(peer) }) });
export const peerEnrollRpc = defineRpc({ name: "node-sync.peer.enroll",
  input: z.object({ peerId: z.string(), hostKey: z.string().max(1000), publicKey: z.string().max(1000), registryRole: peerRole, endpoint: endpoint.optional() }),
  output: z.union([z.object({ ok: z.literal(true), peer }), failure]) });
export const peerAdmitRpc = defineRpc({ name: "node-sync.peer.admit",
  input: z.object({ peerId: z.string(), setId: z.string(), direction: z.enum(["inbound", "outbound"]) }),
  output: z.union([z.object({ ok: z.literal(true) }), failure]) });
export const peerTestRpc = defineRpc({ name: "node-sync.peer.test", input: z.object({ peerId: z.string() }),
  output: z.union([z.object({ ok: z.literal(true), hello, latencyMs: z.number() }), failure]) });
export const registryChangeRpc = defineRpc({ name: "node-sync.registry.change",
  input: z.union([
    z.object({ op: z.literal("create-set"), set: z.object({ id, source: id, destination: id, category, items: z.array(item) }) }),
    z.object({ op: z.literal("delete-set"), setId: id }),
    z.object({ op: z.literal("enroll"), setId: id, item }),
    z.object({ op: z.literal("unenroll"), setId: id, key: z.string() }),
  ]),
  output: z.union([z.object({ status: z.literal("applied"), revision: z.number() }), z.object({ status: z.literal("requested"), requestId: z.string() }),
    z.object({ status: z.literal("rejected"), error: z.string() })]) });
// Optional: lets an open screen hand over its context session. Nothing depends on it; the worker has its own session.
export const attachRpc = defineRpc({ name: "node-sync.attach", input: z.object({}), output: z.object({ attached: z.boolean() }) });

const itemView = z.object({ key: z.string(), state: z.string(), detail: z.string().optional(), desiredDigest: z.string().optional(),
  actualDigest: z.string().optional(), backupId: z.string().optional(), generation: z.number().optional() });
export const enrollTreeRpc = defineRpc({ name: "node-sync.enroll.tree", input: z.object({ setId: id }),
  output: z.union([failure, z.object({ ok: z.literal(true), setId: z.string(), category: z.string(),
    roots: z.array(z.object({ path: z.string(), realpath: z.string(), readable: z.boolean(), reason: z.string().optional() })),
    candidates: z.array(z.object({ key: z.string(), label: z.string(), root: z.string(), enrolled: z.boolean(), managedBySet: z.string().optional(),
      blocked: z.string().optional(), preview: z.array(z.string()).max(50), state: z.string().optional(), unavailable: z.string().optional(),
      // config candidates: Advanced fields need confirmAdvanced; a "full" preview field needs previewDigest = valueDigest.
      advanced: z.boolean().optional(), value: z.string().max(400).optional(), fullText: z.string().max(20_000).optional(),
      valueDigest: z.string().optional() })).max(500) })]) });
export const enrollSetRpc = defineRpc({ name: "node-sync.enroll.set", input: z.object({ setId: id, key: z.string(), enrolled: z.boolean(), root: z.string().optional(),
  confirmAdvanced: z.boolean().optional(), previewDigest: z.string().optional() }),
  output: z.union([z.object({ status: z.literal("applied"), revision: z.number() }), z.object({ status: z.literal("requested"), requestId: z.string() }),
    z.object({ status: z.literal("rejected"), error: z.string() })]) });
export const rootsAddRpc = defineRpc({ name: "node-sync.roots.add", input: z.object({ setId: id, path: z.string().max(1024), confirmTrust: z.boolean() }),
  output: z.union([z.object({ ok: z.literal(true), realpath: z.string() }), failure]) });
export const conflictsListRpc = defineRpc({ name: "node-sync.conflicts.list", input: z.object({}),
  output: z.object({ conflicts: z.array(itemView.extend({ setId: z.string(), compare: z.object({ added: z.array(z.string()), removed: z.array(z.string()),
    changed: z.array(z.string()) }).optional() })).max(200) }) });
export const conflictsResolveRpc = defineRpc({ name: "node-sync.conflicts.resolve", input: z.object({ setId: id, key: z.string(), choice: z.enum(["keep-destination", "take-source"]) }),
  output: itemView });
export const historyListRpc = defineRpc({ name: "node-sync.history.list", input: z.object({ setId: id.optional() }),
  output: z.object({ generations: z.array(z.object({ setId: z.string(), side: z.enum(["source", "destination"]), generation: z.number(), status: z.string(),
    supersededBy: z.number().optional(), items: z.array(itemView) })).max(50),
    backups: z.array(z.object({ setId: z.string(), key: z.string(), backupId: z.string(), generation: z.number(), restorable: z.string(),
      digest: z.string().nullable(), createdAt: z.string() })).max(200),
    items: z.array(itemView.extend({ setId: z.string() })).max(500) }) });
export const itemRollbackRpc = defineRpc({ name: "node-sync.item.rollback", input: z.object({ setId: id, key: z.string(), backupId: z.string() }), output: itemView });
export const itemResumeRpc = defineRpc({ name: "node-sync.item.resume", input: z.object({ setId: id, key: z.string() }), output: z.object({ ok: z.literal(true) }) });
export const setPauseRpc = defineRpc({ name: "node-sync.set.pause", input: z.object({ setId: id }), output: z.object({ ok: z.literal(true) }) });
export const setResumeRpc = defineRpc({ name: "node-sync.set.resume", input: z.object({ setId: id }), output: z.object({ ok: z.literal(true) }) });
// Deliberate repair of a quarantined journal record: removes the hold marker only; the record stays in journal/.invalid/.
export const holdClearRpc = defineRpc({ name: "node-sync.hold.clear", input: z.object({ file: z.string().max(200) }),
  output: z.union([z.object({ ok: z.literal(true) }), failure]) });
