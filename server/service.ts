// Node-local operations behind the RPC surface: node identity, peers, connection test, registry changes and
// draining staged registry bundles. Everything persists through DocStore under <PASEO_HOME>/node-sync.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { writeAtomic } from "./fsatomic.ts";
import { DocStore } from "./store.ts";
import type { NodePaths } from "./paths.ts";
import { bundleDigest } from "./canonical.ts";
import { admitSet, enrollPeer, fingerprint, type EnrollInput, type PeerBinding, type PeerEndpointConfig } from "./peers.ts";
import { receiveRegistry, requestChange, type RegistryDeps } from "./registry.ts";
import { readRequestOwners } from "./inbox.ts";
import { Stores } from "./state.ts";
import { TransportError, type PeerEndpoint, type Transport } from "./transport-ssh.ts";
import { HELLO_SET, ID, PROTOCOL_VERSION, REGISTRY_SET, parseRequest, type RegistryOutcome, type NodeHello, type Registry, type RegistryBundle, type RegistryChange,
  type RegistryRequestBundle } from "../shared/protocol.ts";
import type { SetState } from "../shared/states.ts";

export type NodeRole = "owner" | "follower";
export interface NodeRecord { nodeId?: string; role?: NodeRole }
// clock: milliseconds for retry scheduling; the engine and the service must share it.
export interface ServiceDeps { paths: NodePaths; transport: Transport; now?: () => string; newId?: () => string; stores?: Stores; clock?: () => number }

export interface PublicPeer { peerId: string; registryRole: PeerBinding["registryRole"]; verbs: PeerBinding["verbs"]; sets: PeerBinding["sets"];
  admittedAt: string; endpoint: PeerEndpointConfig | null; fingerprint: string; hostKeyFingerprint: string }
export interface SetView { id: string; category: string; source: string; destination: string; items: number; state: SetState;
  pendingGeneration: number | null; lastResultAt: string | null }
export type TestResult = { ok: true; hello: NodeHello; latencyMs: number } | { ok: false; error: string; detail?: string };

const EMPTY_REGISTRY: Registry = { revision: 0, ownerNodeId: "", sets: [] };
const HELLO_REQUEST = { verb: "fetch-result" as const, setId: HELLO_SET, incarnation: "connection-test", generation: 1 };

export class NodeSyncService {
  readonly paths: NodePaths;
  readonly nodeStore: DocStore<NodeRecord>;
  readonly peers: DocStore<PeerBinding[]>;
  readonly registry: DocStore<Registry>;
  #transport: Transport;
  #now: () => string;
  #newId: () => string;
  readonly stores: Stores;
  #clock: () => number;

  constructor(d: ServiceDeps) {
    this.paths = d.paths;
    this.#transport = d.transport;
    this.#now = d.now ?? (() => new Date().toISOString());
    this.#newId = d.newId ?? (() => randomBytes(8).toString("hex"));
    this.nodeStore = new DocStore<NodeRecord>(d.paths.node, {});
    this.peers = new DocStore<PeerBinding[]>(d.paths.peers, []);
    this.registry = new DocStore<Registry>(d.paths.registry, EMPTY_REGISTRY);
    this.stores = d.stores ?? new Stores(d.paths);
    this.#clock = d.clock ?? Date.now;
  }

  async node(): Promise<{ nodeId: string; role: NodeRole } | null> {
    const n = (await this.nodeStore.read()).value;
    return n.nodeId && n.role ? { nodeId: n.nodeId, role: n.role } : null;
  }

  // One-time local identity. The owner node also becomes the registry's owner.
  async init(input: { nodeId: string; role: NodeRole }): Promise<{ ok: true; node: { nodeId: string; role: NodeRole } } | { ok: false; error: string }> {
    if (!ID.test(input.nodeId)) return { ok: false, error: "invalid-node-id" };
    if (input.role !== "owner" && input.role !== "follower") return { ok: false, error: "invalid-role" };
    let conflict = false;
    await this.nodeStore.update(n => {
      if (n.nodeId && (n.nodeId !== input.nodeId || n.role !== input.role)) { conflict = true; return n; }
      return { nodeId: input.nodeId, role: input.role };
    });
    if (conflict) return { ok: false, error: "already-initialized" };
    if (input.role === "owner") await this.registry.update(r => (r.ownerNodeId ? r : { ...r, ownerNodeId: input.nodeId }));
    return { ok: true, node: { nodeId: input.nodeId, role: input.role } };
  }

  async overview() {
    const node = await this.node();
    const registry = (await this.registry.read()).value;
    const bindings = (await this.peers.read()).value;
    const sets: SetView[] = registry.sets.map(s => {
      const mine = node && (s.destination === node.nodeId ? "inbound" : s.source === node.nodeId ? "outbound" : null);
      const admitted = !mine || bindings.some(b => b.sets.some(x => x.setId === s.id && x.direction === mine));
      return { id: s.id, category: s.category, source: s.source, destination: s.destination, items: s.items.length,
        state: admitted ? "idle" : "not-admitted", pendingGeneration: null, lastResultAt: null };
    });
    return { node, registry: { revision: registry.revision, ownerNodeId: registry.ownerNodeId }, sets, peers: bindings.length,
      // Bounded: one record per follower, and the 20 most recent follower requests.
      replication: Object.entries((await this.stores.replication.read()).value).slice(0, 10).map(([peerId, r]) =>
        ({ peerId, acked: r.acked, attempts: r.attempts, ...(r.lastError ? { lastError: r.lastError } : {}) })),
      requests: Object.values((await this.stores.requests.read()).value).sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 20)
        .map(r => ({ requestId: r.requestId, summary: r.summary, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.revision !== undefined ? { revision: r.revision } : {}) })) };
  }

  async listPeers(): Promise<PublicPeer[]> {
    return (await this.peers.read()).value.map(b => ({ peerId: b.peerId, registryRole: b.registryRole, verbs: b.verbs, sets: b.sets,
      admittedAt: b.admittedAt, endpoint: b.endpoint ?? null, fingerprint: fingerprint(b.publicKey), hostKeyFingerprint: fingerprint(b.hostKey) }));
  }

  knownHostsPath(peerId: string): string { return `${this.paths.root}/peers/${peerId}/known_hosts`; }

  // Enrollment pins the peer's host key in a per-peer known_hosts file used by the transport.
  async enroll(input: EnrollInput): Promise<{ ok: true; peer: PublicPeer } | { ok: false; error: string }> {
    const r = await enrollPeer(this.peers, input, this.#now());
    if (!r.ok) return r;
    if (r.binding.endpoint) {
      const { host, port } = r.binding.endpoint;
      const target = port === 22 ? host : `[${host}]:${port}`;
      await mkdir(`${this.paths.root}/peers/${r.binding.peerId}`, { recursive: true, mode: 0o700 });
      await writeAtomic(this.knownHostsPath(r.binding.peerId), `${target} ${r.binding.hostKey.split(" ").slice(0, 2).join(" ")}\n`);
    }
    return { ok: true, peer: (await this.listPeers()).find(p => p.peerId === r.binding.peerId)! };
  }

  admit(input: { peerId: string; setId: string; direction: "inbound" | "outbound" }) {
    return admitSet(this.peers, input.peerId, input.setId, input.direction);
  }

  #endpoint(b: PeerBinding): PeerEndpoint | null {
    return b.endpoint ? { peerId: b.peerId, host: b.endpoint.host, port: b.endpoint.port, user: b.endpoint.user,
      key: b.endpoint.keyPath, knownHosts: this.knownHostsPath(b.peerId) } : null;
  }

  async testPeer(peerId: string): Promise<TestResult> {
    const b = (await this.peers.read()).value.find(x => x.peerId === peerId);
    if (!b) return { ok: false, error: "unknown-peer" };
    const ep = this.#endpoint(b);
    if (!ep) return { ok: false, error: "no-endpoint" };
    const t0 = Date.now();
    try {
      const res = await this.#transport.call(ep, HELLO_REQUEST, 20_000);
      if (!res.ok) return { ok: false, error: res.error, detail: res.detail };
      if (!res.node) return { ok: false, error: "peer-not-initialized" };
      return { ok: true, hello: res.node, latencyMs: Date.now() - t0 };
    } catch (e) {
      const kind = e instanceof TransportError ? e.kind : (e as { kind?: string }).kind ?? "unreachable";
      // ssh's own diagnostic (no key material: ssh never prints keys), for the operator.
      const detail = e instanceof Error ? e.message.replace(/[\r\n]+/g, " ").slice(0, 300) : undefined;
      return detail ? { ok: false, error: kind, detail } : { ok: false, error: kind };
    }
  }

  // Endpoint for a peer from a FRESH read of the bindings (retries never use a binding captured earlier).
  async endpointFor(peerId: string): Promise<PeerEndpoint | null> {
    const b = (await this.peers.read()).value.find(x => x.peerId === peerId);
    return b ? this.#endpoint(b) : null;
  }

  #deps(node: { nodeId: string; role: NodeRole }): RegistryDeps {
    return {
      store: this.registry, node, now: this.#now, newIncarnation: () => this.#newId(), newRequestId: () => this.#newId(),
      pushToOwner: async (b: RegistryRequestBundle) => {
        const owner = (await this.peers.read()).value.find(x => x.registryRole === "owner");
        const ep = owner && this.#endpoint(owner);
        if (!ep) throw new Error("no registry owner endpoint");
        const res = await this.#transport.call(ep, { verb: "put", bundle: b });
        if (!res.ok) throw new Error(res.error);
      },
      replicate: async () => { await this.replicatePending({ force: true }); },
    };
  }

  // Owner: sends the NEWEST registry revision to every follower whose durable ack is behind. Survives restarts
  // (replication.json); failures back off (5 s doubling, cap 900 s) unless forced right after a change.
  async replicatePending(o: { force?: boolean; nowMs?: number } = {}): Promise<void> {
    const node = await this.node();
    if (node?.role !== "owner") return;
    const r = (await this.registry.read()).value;
    const followers = (await this.peers.read()).value.filter(x => x.registryRole === "follower");
    const now = o.nowMs ?? this.#clock();
    for (const f of followers) {
      const rec = (await this.stores.replication.read()).value[f.peerId] ?? { acked: 0, attempts: 0, nextRetryAt: 0 };
      if (rec.acked >= r.revision || (!o.force && rec.nextRetryAt > now)) continue;
      const ep = await this.endpointFor(f.peerId);
      if (!ep) continue;
      const body = { kind: "registry" as const, protocol: PROTOCOL_VERSION, revision: r.revision, registry: r };
      let error: string | undefined;
      try {
        const res = await this.#transport.call(ep, { verb: "put", bundle: { ...body, digest: bundleDigest(body) } });
        if (!res.ok) error = res.error;
      } catch (e) { error = e instanceof TransportError ? e.kind : "unreachable"; }
      await this.stores.replication.update(all => {
        const prev = all[f.peerId] ?? { acked: 0, attempts: 0, nextRetryAt: 0 };
        const next = error === undefined ? { acked: Math.max(prev.acked, r.revision), attempts: 0, nextRetryAt: 0, lastAttemptAt: this.#now() }
          : { ...prev, attempts: prev.attempts + 1, lastError: error, lastAttemptAt: this.#now(),
              nextRetryAt: now + Math.min(5_000 * 2 ** prev.attempts, 900_000) };
        return { ...all, [f.peerId]: next };
      });
    }
  }

  async change(c: RegistryChange) {
    const node = await this.node();
    if (!node) return { status: "rejected" as const, error: "node-not-initialized" };
    const r = await requestChange(this.#deps(node), c);
    // A follower keeps its request durably until it has fetched the owner's outcome.
    if (r.status === "requested") {
      const base = (await this.registry.read()).value.revision;
      await this.stores.requests.update(all => ({ ...all, [r.requestId]: { requestId: r.requestId, op: c.op, summary: summarize(c), baseRevision: base,
        status: "requested", sentAt: this.#now(), attempts: 0, nextRetryAt: 0 } }));
    }
    return r;
  }

  // Follower: fetches the owner's outcome for each open request over the "_registry" channel.
  async pollRequests(o: { nowMs?: number } = {}): Promise<void> {
    const node = await this.node();
    if (node?.role !== "follower") return;
    const owner = (await this.peers.read()).value.find(x => x.registryRole === "owner");
    const ep = owner && (await this.endpointFor(owner.peerId));
    if (!ep) return;
    const now = o.nowMs ?? this.#clock();
    for (const req of Object.values((await this.stores.requests.read()).value)) {
      if (req.status !== "requested" || req.nextRetryAt > now) continue;
      let outcome: RegistryOutcome | undefined;
      try {
        const res = await this.#transport.call(ep, { verb: "fetch-result", setId: REGISTRY_SET, incarnation: req.requestId, generation: 1 });
        if (res.ok && res.verb === "fetch-result" && res.status === "done") outcome = res.registry;
      } catch { /* retried with backoff below */ }
      await this.stores.requests.update(all => {
        const cur = all[req.requestId]!;
        return { ...all, [req.requestId]: outcome
          ? { ...cur, status: outcome.status, settledAt: outcome.at, ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}), ...(outcome.error ? { error: outcome.error } : {}) }
          : { ...cur, attempts: cur.attempts + 1, nextRetryAt: now + Math.min(5_000 * 2 ** cur.attempts, 900_000) } };
      });
    }
  }

  // Processes staged registry bundles: snapshots on a follower, change requests on the owner. Each file is moved to
  // processed/ with its outcome in the name. A file that cannot be read or validated is quarantined and does not block
  // the others. A request based on an older revision than the owner's is rejected (stale-base), never rebased.
  async drain(): Promise<{ processed: string[] }> {
    const node = await this.node();
    if (!node) return { processed: [] };
    const dir = this.paths.registryInbox;
    const files = (await readdir(dir).catch(() => [] as string[])).filter(f => /^(registry-\d+|request-[a-z0-9-]+)\.json$/.test(f)).sort((x, y) =>
      x.startsWith("registry-") && y.startsWith("registry-") ? Number(x.slice(9, -5)) - Number(y.slice(9, -5)) : x.localeCompare(y));
    const processed: string[] = [];
    for (const f of files) {
      let bundle: RegistryBundle | RegistryRequestBundle;
      try {
        bundle = JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
        const parsed = parseRequest({ verb: "put", bundle });
        if ("error" in parsed || bundleDigest(bundle) !== bundle.digest) throw new Error("invalid staged bundle");
      } catch (e) {
        await mkdir(`${dir}/quarantine`, { recursive: true, mode: 0o700 });
        await rename(`${dir}/${f}`, `${dir}/quarantine/${f}`).catch(() => {});
        processed.push(`${f}:quarantined (${(e as Error).message.slice(0, 80)})`);
        continue;
      }
      let outcome: string;
      if (bundle.kind === "registry") {
        const owner = (await this.peers.read()).value.find(b => b.registryRole === "owner");
        if (node.role !== "follower") outcome = "ignored-not-follower";
        else if (!owner || bundle.registry.ownerNodeId !== owner.peerId) outcome = "rejected-owner-mismatch";
        else outcome = (await receiveRegistry(this.#deps(node), bundle)).status;
      } else if (node.role !== "owner") outcome = "ignored-not-owner";
      else {
        const requester = (await readRequestOwners(this.paths))[bundle.requestId]?.peer;
        const current = (await this.registry.read()).value.revision;
        const result: RegistryOutcome = bundle.baseRevision !== current
          ? { requestId: bundle.requestId, status: "rejected", error: `stale-base: request based on revision ${bundle.baseRevision}, owner is at ${current}`, at: this.#now() }
          : await requestChange(this.#deps(node), bundle.change).then(r => r.status === "applied"
            ? { requestId: bundle.requestId, status: "applied" as const, revision: r.revision, at: this.#now() }
            : { requestId: bundle.requestId, status: "rejected" as const, error: r.status === "rejected" ? r.error : "unexpected", at: this.#now() });
        // The first outcome for a requestId is final; it is bound to the requester recorded at staging (none: unfetchable).
        await this.stores.registryResults.update(all => all[bundle.requestId] ? all : ({ ...all, [bundle.requestId]: { ...result, ...(requester ? { requester } : {}) } }));
        outcome = result.status === "applied" ? "applied" : `rejected-${result.error!.split(":")[0]}`;
      }
      await mkdir(`${dir}/processed`, { recursive: true, mode: 0o700 });
      await rename(`${dir}/${f}`, `${dir}/processed/${f.slice(0, -5)}.${outcome}.json`);
      processed.push(`${f}:${outcome}`);
    }
    return { processed };
  }
}

function summarize(c: RegistryChange): string {
  switch (c.op) {
    case "create-set": return `create ${c.set.id} (${c.set.category}, ${c.set.source} -> ${c.set.destination})`;
    case "delete-set": return `delete ${c.setId}`;
    case "enroll": return `enroll ${c.item.key} in ${c.setId}`;
    case "unenroll": return `unenroll ${c.key} from ${c.setId}`;
  }
}
