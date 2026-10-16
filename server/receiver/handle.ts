// Receiver request handling, shared by the forced-command entry (main.ts) and in-process tests.
import { PROTOCOL_VERSION, CAPABILITIES, HELLO_SET, REGISTRY_SET, type RegistryOutcome, type NodeHello, type ReceiverRequest, type ReceiverResponse,
  type Registry, type RejectReason } from "../../shared/protocol.ts";
import type { NodePaths } from "../paths.ts";
import { DocStore } from "../store.ts";
import { authorize, rejectDetail, resolveBinding, type PeerBinding } from "../peers.ts";
import { acceptBundle, readResult, stageRegistry } from "../inbox.ts";

export async function nodeHello(paths: NodePaths): Promise<NodeHello | undefined> {
  const node = (await new DocStore<{ nodeId?: string }>(paths.node, {}).read()).value;
  return node.nodeId ? { nodeId: node.nodeId, protocol: PROTOCOL_VERSION, capabilities: { ...CAPABILITIES } } : undefined;
}

export const reject = (error: RejectReason, detail: string, node?: NodeHello): ReceiverResponse =>
  ({ ok: false, error, detail, ...(node ? { node } : {}) });

export async function handleRequest(paths: NodePaths, peer: string, req: ReceiverRequest): Promise<ReceiverResponse> {
  const node = await nodeHello(paths);
  const bindings = (await new DocStore<PeerBinding[]>(paths.peers, []).read()).value;
  const registry = (await new DocStore<Registry>(paths.registry, { revision: 0, ownerNodeId: "", sets: [] }).read()).value;
  const binding = resolveBinding(bindings, peer);
  const auth = authorize(binding, req);
  if (!auth.ok) return reject(auth.error, rejectDetail(binding, req, auth.error), node);
  const n = node ? { node } : {};
  if (req.verb === "fetch-result") {
    if (req.setId === HELLO_SET) return { ok: true, verb: "fetch-result", status: "unknown", ...n };
    if (req.setId === REGISTRY_SET) {
      const outcomes = (await new DocStore<Record<string, RegistryOutcome>>(`${paths.root}/registry-results.json`, {}).read()).value;
      // Only the authenticated peer that staged the request learns its outcome. Another follower, or an outcome whose
      // requester was never recorded, gets "unknown" (it does not reveal that the requestId exists).
      const o = outcomes[req.incarnation];
      if (!o || o.requester !== binding!.peerId) return { ok: true, verb: "fetch-result", status: "unknown", ...n };
      const { requester: _r, ...outcome } = o;
      return { ok: true, verb: "fetch-result", status: "done", registry: outcome, ...n };
    }
    const r = await readResult(paths, req.setId, req.incarnation, req.generation);
    return { ok: true, verb: "fetch-result", status: r.status, ...(r.result ? { result: r.result } : {}), ...n };
  }
  const b = req.bundle;
  if (b.kind !== "data") {
    const r = await stageRegistry(paths, b, binding!.peerId);
    return "error" in r ? reject(r.error, "registry bundle rejected", node) : { ok: true, verb: "put", status: r.status, ...n };
  }
  // Admitted only when both the local binding (checked by authorize) and the stored registry name the set.
  const set = registry.sets.find(s => s.id === b.setId);
  const r = await acceptBundle(paths, set ? set.incarnation : null, b);
  return "error" in r ? reject(r.error, "bundle rejected", node) : { ok: true, verb: "put", status: r.status, ...n };
}
