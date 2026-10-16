// The node worker. One serialized queue per node, every job under worker.lock: recovery, source and destination
// steps, registry drain/replication/request polling, and every operator action. Nothing here runs concurrently.
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { withLock, writeAtomic } from "./fsatomic.ts";
import { bundleDigest, digest } from "./canonical.ts";
import { pendingGenerations, writeResult } from "./inbox.ts";
import { classifyRecovery, type Journal, type JournalHold } from "./journal.ts";
import type { BackupStore } from "./backup-store.ts";
import type { NodeSyncService } from "./service.ts";
import { TransportError, type Transport } from "./transport-ssh.ts";
import { checkBundle, checkItem, type CapabilityFacts } from "./capability.ts";
import { emptySource, type DestinationRuntime, type ItemRecord, type SourceRuntime, type Stores } from "./state.ts";
import type { CategoryDriver } from "./drivers/skills.ts";
import { CAPABILITIES, PROTOCOL_VERSION, type Category, type DataBundle, type DesiredItem, type GenerationResult, type ItemResult,
  type NodeHello, type SetDefinition } from "../shared/protocol.ts";

export interface EngineDeps {
  service: NodeSyncService; stores: Stores; transport: Transport; journal: Journal; backups: BackupStore;
  drivers: Record<Category, CategoryDriver>; now?: () => number; facts?: () => CapabilityFacts; tickMs?: number; debounceMs?: number;
  // Test-only crash points inside the destination commit (throwing simulates a crash after the preceding durable step).
  faults?: { afterResult?(): void; afterItemSave?(n: number): void; beforeSaveDest?(): void };
}

const OPERATOR_STATES = (s: string) => s.startsWith("blocked") || s === "failed" || s === "awaiting-operator";
// States set by an operator decision or held for one; a result without a trustworthy timestamp never overrides them.
const HELD_STATES = (s: string) => s === "paused" || s === "unmanaged" || OPERATOR_STATES(s);
const BACKOFF = (attempt: number) => Math.min(5_000 * 2 ** Math.max(attempt - 1, 0), 900_000);
const emptyDest = (): DestinationRuntime => ({ appliedGeneration: 0, detached: [], paused: false });

export class Engine {
  #d: EngineDeps;
  #chain: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  #stopped = false;
  #started: Promise<void> | null = null;
  // False until start-up recovery (reconcile + journal) has completed once. Every asset-mutating path runs it first.
  #recovered = false;
  lastError: { at: string; message: string } | null = null;

  constructor(d: EngineDeps) { this.#d = d; }
  #now() { return this.#d.now?.() ?? Date.now(); }
  #facts(): CapabilityFacts { return this.#d.facts?.() ?? { pluginRemovalProof: false, selectionPatchable: false, pluginLsShape: false, sessionAttached: false }; }

  // Serialized and cross-process exclusive: the queue orders jobs in this process, worker.lock excludes any other worker.
  // After stop() nothing new runs: a job still waiting in the queue is refused when its turn comes.
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.#chain.then(() => {
      if (this.#stopped) throw new Error("engine stopped");
      return withLock(this.#d.service.paths.workerLock, fn, { timeoutMs: 60_000 });
    });
    this.#chain = job.catch(() => {});
    return job;
  }

  #fail(what: string, e: unknown) { this.lastError = { at: new Date().toISOString(), message: `${what}: ${String(e).slice(0, 280)}` }; }

  // Idempotent. A failed start-up recovery does not disable ticking: it is recorded in lastError, recoveryPending stays
  // true, and every tick retries it before any destination work or operator action may write assets.
  // A stopped engine is final: start() after stop() does nothing.
  start(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#started ??= (async () => {
      try { await this.recover(); } catch (e) { this.#fail("recovery", e); }
      if (this.#stopped) return;
      this.#timer = setInterval(() => { if (!this.#stopped) void this.tick().catch(e => this.#fail("tick", e)); }, this.#d.tickMs ?? 5_000);
      this.#timer.unref?.();
    })();
  }
  // Returns only when no job of this engine is running and no timer remains; safe to call more than once.
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    for (const t of this.#debounce.values()) clearTimeout(t);
    this.#debounce.clear();
    await this.#chain;
    if (this.#started) await this.#started;
  }
  // Introspection for the lifecycle tests and the overview.
  get active() { return { timer: this.#timer !== null, debounces: this.#debounce.size, stopped: this.#stopped }; }
  get recoveryPending() { return !this.#recovered; }

  notifyChanged(setId: string): void {
    if (this.#stopped) return;
    clearTimeout(this.#debounce.get(setId));
    const t = setTimeout(() => { this.#debounce.delete(setId); void this.sourceTick(setId).catch(() => {}); }, this.#d.debounceMs ?? 1_000);
    t.unref?.();
    this.#debounce.set(setId, t);
  }

  // One full pass: registry work, then every set this node takes part in. A failing set does not stop the others; a
  // node-level problem (registry work, recovery) stays conservative: without recovery no destination step runs.
  tick(): Promise<void> {
    return this.enqueue(async () => {
      const node = await this.#d.service.node();
      if (!node) return;
      const nowMs = this.#now();
      await this.#d.service.drain();
      await this.#d.service.replicatePending({ nowMs });
      await this.#d.service.pollRequests({ nowMs });
      const recovered = await this.#ensureRecovered();
      for (const set of (await this.#d.service.registry.read()).value.sets) {
        if (set.source === node.nodeId) await this.#source(set).catch(e => this.#fail(`${set.id} (source)`, e));
        if (set.destination === node.nodeId && recovered) await this.#destination(set).catch(e => this.#fail(`${set.id} (destination)`, e));
      }
    });
  }
  sourceTick(setId: string): Promise<void> { return this.enqueue(async () => { const s = await this.#set(setId); if (s) await this.#source(s); }); }
  destinationTick(setId: string): Promise<void> {
    return this.enqueue(async () => { const s = await this.#set(setId); if (s && await this.#ensureRecovered()) await this.#destination(s); });
  }
  recover(): Promise<void> { return this.enqueue(() => this.#runRecovery()); }

  async #runRecovery() {
    const node = await this.#d.service.node();
    for (const set of (await this.#d.service.registry.read()).value.sets) if (node && set.destination === node.nodeId) await this.#reconcile(set);
    await this.#recover();
    this.#recovered = true;
  }
  async #ensureRecovered(): Promise<boolean> {
    if (this.#recovered) return true;
    try { await this.#runRecovery(); return true; } catch (e) { this.#fail("recovery", e); return false; }
  }

  // Quarantined journal records (see Journal.holds). A hold naming a set this node knows stops asset writes for that
  // set; any other hold (no set, or an unknown one) stops them for the whole node. Registry work, source steps and
  // read-only views continue. Cleared only by the operator after repair.
  async holds(): Promise<(JournalHold & { scope: "node" | "set" })[]> {
    const known = new Set((await this.#d.service.registry.read()).value.sets.map(s => s.id));
    return (await this.#d.journal.holds()).map(h => ({ ...h, scope: h.setId && known.has(h.setId) ? "set" as const : "node" as const }));
  }
  async #heldReason(setId: string): Promise<string | null> {
    const h = (await this.holds()).find(x => x.scope === "node" || x.setId === setId);
    return h ? `held: ${h.reason} (journal/.invalid/${h.file}${h.scope === "node" ? ", whole node" : ""}); repair, then clear the hold` : null;
  }
  // Refuses an asset-mutating operator action until recovery has run and no hold covers the set.
  async #guard(setId: string, key: string): Promise<ItemResult | null> {
    if (!(await this.#ensureRecovered())) return { key, state: "failed", detail: "recovery has not completed; see the worker error" };
    const held = await this.#heldReason(setId);
    return held ? { key, state: "failed", detail: held } : null;
  }
  clearHold(file: string): Promise<boolean> { return this.enqueue(() => this.#d.journal.clearHold(file)); }

  // The single authoritative pause. Runtime "paused" fields written before this store existed count only while the
  // store has no entry for the set.
  async #paused(setId: string): Promise<boolean> {
    const p = (await this.#d.stores.pauses.read()).value[setId];
    if (p !== undefined) return p;
    return !!(await this.#dest(setId)).paused || !!(await this.#d.stores.sources.read()).value[setId]?.paused;
  }

  async #set(id: string) { return (await this.#d.service.registry.read()).value.sets.find(s => s.id === id) ?? null; }
  async #hello(): Promise<NodeHello | null> {
    const n = await this.#d.service.node();
    return n ? { nodeId: n.nodeId, protocol: PROTOCOL_VERSION, capabilities: { ...CAPABILITIES } } : null;
  }

  // ---- source side ----------------------------------------------------------------------------------------------

  async #saveSource(id: string, rt: SourceRuntime) { await this.#d.stores.sources.update(all => ({ ...all, [id]: rt })); }

  async #source(set: SetDefinition) {
    const all = (await this.#d.stores.sources.read()).value;
    let rt: SourceRuntime = all[set.id]?.incarnation === set.incarnation ? all[set.id]! : { ...emptySource(), incarnation: set.incarnation };
    if (await this.#paused(set.id)) return;
    const binding = (await this.#d.service.peers.read()).value.find(b => b.peerId === set.destination);
    if (!binding?.sets.some(s => s.setId === set.id && s.direction === "outbound")) {
      await this.#saveSource(set.id, { ...rt, state: "not-admitted", detail: "set not admitted outbound for the destination peer on this node" });
      return;
    }
    const pinned = rt.state === "peer-identity-changed" || rt.delivery?.state === "peer-identity-changed";
    if (pinned && rt.identityPin === binding.hostKey) return; // until the operator re-pins
    const snap = await this.#d.drivers[set.category].snapshot(set);
    if (snap.status === "unreadable") {
      // No tombstones from an unreadable source; an already built bundle (older, consistent state) may still go out.
      rt = { ...rt, state: "source-unreadable", detail: snap.reason };
    } else {
      const enrolled = set.items.map(i => i.key);
      const released = [...new Set([...rt.releasePending, ...rt.sentKeys])].filter(k => !enrolled.includes(k)).sort();
      const items = [...snap.items].sort((a, b) => a.key.localeCompare(b.key));
      const content = digest({ incarnation: set.incarnation, items: items.map(i => ({ key: i.key, digest: i.digest })), tombstones: [...snap.missing].sort(), released });
      const sourceItems: SourceRuntime["sourceItems"] = {};
      for (const b of snap.blocked) sourceItems[b.key] = { state: "blocked: unsafe path", detail: `${b.detail} (not sent; the destination copy is left as it is)` };
      for (const i of items) sourceItems[i.key] = rt.sourceItems[i.key]?.state.startsWith("blocked: unsafe") ? { state: "pending" } : rt.sourceItems[i.key] ?? { state: "pending" };
      // Readable again: a pending delivery shows its own last failure, if any.
      const back = rt.state === "source-unreadable";
      rt = { ...rt, sourceItems, state: rt.pending ? (back ? rt.delivery?.state ?? "syncing" : rt.state) : "idle",
        detail: rt.pending && back ? rt.delivery?.detail : undefined, releasePending: released };
      if (content !== rt.lastDigest) {
        const g = rt.lastGeneration + 1;
        const body: Omit<DataBundle, "digest"> = { kind: "data", protocol: PROTOCOL_VERSION, capability: 1, setId: set.id, incarnation: set.incarnation,
          generation: g, complete: true, items, tombstones: [...snap.missing].sort(), released };
        // The bundle is durable before it is sent: retries re-send exactly this generation and digest.
        await mkdir(`${this.#d.service.paths.root}/outbox/${set.id}`, { recursive: true, mode: 0o700 });
        await writeAtomic(this.#d.stores.outbox(set.id, g), JSON.stringify({ ...body, digest: bundleDigest(body) }));
        rt = { ...rt, lastGeneration: g, lastDigest: content, pending: g, putAccepted: 0, sentKeys: enrolled, attempt: 0, nextRetryAt: 0, state: "syncing" };
      }
    }
    await this.#saveSource(set.id, rt);
    if (rt.pending && this.#now() >= rt.nextRetryAt) await this.#deliver(set, rt);
  }

  async #deliver(set: SetDefinition, rt0: SourceRuntime) {
    let rt = rt0;
    const g = rt.pending!;
    const ep = await this.#d.service.endpointFor(set.destination);
    // A delivery failure never hides a source problem: source-unreadable stays the state and the transport failure is
    // recorded beside it in delivery.
    const fail = async (state: SourceRuntime["state"], detail: string, extra: Partial<SourceRuntime> = {}) => {
      const attempt = rt.attempt + 1, unreadable = rt.state === "source-unreadable";
      await this.#saveSource(set.id, { ...rt, ...extra, state: unreadable ? rt.state : state, detail: unreadable ? rt.detail : detail,
        delivery: { state, detail }, attempt, nextRetryAt: this.#now() + BACKOFF(attempt) });
    };
    if (!ep) return fail("peer-offline", "no endpoint enrolled for the destination peer");
    // The retained bundle is local state: missing, unparseable or failing its own digest all mean "unusable", never a
    // thrown error or a transport failure. An unusable file is left in place as evidence.
    const text = await readFile(this.#d.stores.outbox(set.id, g), "utf8").catch(() => null);
    let retained: DataBundle | null = null;
    if (text !== null) {
      try {
        const b = JSON.parse(text) as DataBundle;
        const { digest: d, ...body } = b;
        if (b && typeof b === "object" && b.generation === g && d === bundleDigest(body)) retained = b;
      } catch { /* unusable */ }
    }
    if (!retained && rt.putAccepted !== g) {
      // Local state fault, not a peer problem. The destination never accepted generation g, so the next source step
      // rebuilds from the current snapshot as generation g+1 (higher than anything the destination can hold); an
      // unreadable source builds nothing (no tombstones) and keeps its source-unreadable state.
      const why = `local outbox bundle for generation ${g} is ${text === null ? "missing" : "unreadable or corrupt"}; rebuilding as a new generation`;
      const unreadable = rt.state === "source-unreadable";
      await this.#saveSource(set.id, { ...rt, pending: null, lastDigest: null, attempt: 0, nextRetryAt: 0, state: unreadable ? rt.state : "syncing",
        detail: unreadable ? rt.detail : why, delivery: { state: "syncing", detail: why } });
      return;
    }
    try {
      if (rt.putAccepted !== g) {
        const bundle = retained!;
        const put = await this.#d.transport.call(ep, { verb: "put", bundle });
        if (!put.ok) {
          if (put.error === "generation-conflict") return fail("syncing", "destination holds a different bundle for this generation; a new generation follows", { lastDigest: null });
          return fail(put.error === "set-not-admitted" ? "not-admitted" : "syncing", `put rejected: ${put.error} (${put.detail})`);
        }
        rt = { ...rt, putAccepted: g };
        await this.#saveSource(set.id, rt);
      }
      // A lost response only ever leads to fetching the persisted result again, never to a re-apply.
      const res = await this.#d.transport.call(ep, { verb: "fetch-result", setId: set.id, incarnation: set.incarnation, generation: g });
      if (!res.ok || res.verb !== "fetch-result") return fail("syncing", `fetch-result rejected: ${res.ok ? "unexpected" : res.error}`);
      if (res.status === "unknown") return fail("syncing", "destination has no record of this generation; it will be sent again", { putAccepted: 0 });
      if (res.status === "pending") return fail("syncing", "waiting for the destination to apply");
      const result = res.result!;
      // Without the retained bundle the released keys stay pending and are sent again (release is idempotent).
      const releasedSent = retained?.released ?? [];
      const sourceItems = { ...rt.sourceItems };
      for (const i of result.items) if (!sourceItems[i.key]?.state.startsWith("blocked: unsafe")) sourceItems[i.key] = { state: i.state, ...(i.detail ? { detail: i.detail } : {}) };
      await this.#saveSource(set.id, { ...rt, pending: null, ackedGeneration: g, lastResult: result, attempt: 0, nextRetryAt: 0, sourceItems, delivery: undefined,
        releasePending: rt.releasePending.filter(k => !releasedSent.includes(k)), state: rt.state === "source-unreadable" ? rt.state : "idle",
        detail: rt.state === "source-unreadable" ? rt.detail : undefined });
    } catch (e) {
      const kind = e instanceof TransportError ? e.kind : (e as { kind?: string }).kind ?? "unreachable";
      const binding = (await this.#d.service.peers.read()).value.find(b => b.peerId === set.destination);
      if (kind === "host-key") return fail("peer-identity-changed", "host key mismatch: re-pin the peer in the Peer tab", { identityPin: binding?.hostKey });
      return fail(kind === "bad-frame" ? "syncing" : "peer-offline", `${kind}: ${e instanceof Error ? e.message.slice(0, 200) : ""}`);
    }
  }

  // ---- destination side -----------------------------------------------------------------------------------------

  async #dest(id: string): Promise<DestinationRuntime> { return (await this.#d.stores.destinations.read()).value[id] ?? emptyDest(); }
  async #saveDest(id: string, rt: DestinationRuntime) { await this.#d.stores.destinations.update(all => ({ ...all, [id]: rt })); }
  async #items(setId: string): Promise<Record<string, ItemRecord>> { return (await this.#d.stores.items.read()).value[setId] ?? {}; }
  async #saveItem(setId: string, r: ItemResult, g?: number) {
    await this.#d.stores.items.update(all => {
      const prev = all[setId]?.[r.key] ?? { state: "pending", baseline: null, updatedAt: "" };
      const next: ItemRecord = { ...prev, state: r.state, updatedAt: new Date().toISOString(), detail: r.detail,
        ...(r.desiredDigest ? { desiredDigest: r.desiredDigest } : {}), ...(r.actualDigest ? { actualDigest: r.actualDigest } : {}),
        ...(r.backupId ? { backupId: r.backupId } : {}), ...(g !== undefined ? { generation: g } : {}) };
      return { ...all, [setId]: { ...(all[setId] ?? {}), [r.key]: next } };
    });
  }
  async #setItemState(setId: string, key: string, patch: Partial<ItemRecord>) {
    await this.#d.stores.items.update(all => {
      const prev = all[setId]?.[key] ?? { state: "pending", baseline: null, updatedAt: "" };
      return { ...all, [setId]: { ...(all[setId] ?? {}), [key]: { ...prev, ...patch, updatedAt: new Date().toISOString() } } };
    });
  }
  // Applied bundles stay in inbox/<set>/<g>.json; older staged ones may have moved to superseded/.
  async #bundle(setId: string, g: number): Promise<DataBundle | null> {
    if (g < 1) return null;
    const dir = this.#d.service.paths.inbox(setId);
    for (const p of [`${dir}/${g}.json`, `${dir}/superseded/${g}.json`]) {
      const b = await readFile(p, "utf8").then(t => JSON.parse(t) as DataBundle, () => null);
      if (b) return b;
    }
    return null;
  }

  // A durable result is authoritative. If the node stopped after writing it but before items.json or appliedGeneration
  // caught up, the bookkeeping is completed from the result: no re-apply, no backup, baselines untouched (the applier
  // persisted them). Items already saved for that generation, or changed after the result was written, are kept;
  // appliedGeneration never moves backwards. Results of another incarnation, rejected or superseded results are ignored.
  // A result without "at" (written before it existed, or damaged) cannot prove it is newer than an operator decision,
  // so paused, unmanaged and operator-held records are then kept; other records are completed from it.
  async #reconcile(set: SetDefinition) {
    const drt = await this.#dest(set.id);
    const dir = `${this.#d.service.paths.root}/results/${set.id}`;
    let best: GenerationResult | null = null;
    for (const f of (await readdir(dir).catch(() => [] as string[])).filter(x => /^\d+\.json$/.test(x))) {
      const r = await readFile(`${dir}/${f}`, "utf8").then(t => JSON.parse(t) as GenerationResult, () => null);
      if (!r || r.incarnation !== set.incarnation || r.status !== "applied" || r.supersededBy !== undefined || r.generation <= drt.appliedGeneration) continue;
      if (!best || r.generation > best.generation) best = r;
    }
    if (!best) return;
    const g = best.generation, at = best.at;
    const items = await this.#items(set.id);
    for (const r of best.items) {
      const rec = items[r.key];
      if (rec && ((rec.generation ?? 0) >= g || (at ? rec.updatedAt > at : HELD_STATES(rec.state)))) continue;
      await this.#saveItem(set.id, r, g);
    }
    const now = await this.#dest(set.id);
    await this.#saveDest(set.id, { ...now, appliedGeneration: Math.max(now.appliedGeneration, g) });
  }

  async #destination(set: SetDefinition) {
    const drt = await this.#dest(set.id);
    if (await this.#paused(set.id)) return;
    const binding = (await this.#d.service.peers.read()).value.find(b => b.peerId === set.source);
    if (!binding?.sets.some(s => s.setId === set.id && s.direction === "inbound")) return;
    await this.#reconcile(set);
    if ((await this.#d.journal.unfinished()).some(r => r.setId === set.id)) await this.#recover(set.id);
    // Staged bundles wait; nothing is applied while a quarantined journal record covers this set or node.
    if (await this.#heldReason(set.id)) return;
    const gens = await pendingGenerations(this.#d.service.paths, set.id);
    if (gens.length) {
      const newest = gens.at(-1)!;
      // Only the newest desired state is applied; older staged generations are answered as superseded.
      for (const g of gens.slice(0, -1)) {
        await writeResult(this.#d.service.paths, { setId: set.id, incarnation: set.incarnation, generation: g, status: "applied", items: [], supersededBy: newest });
        await mkdir(`${this.#d.service.paths.inbox(set.id)}/superseded`, { recursive: true });
        await rename(`${this.#d.service.paths.inbox(set.id)}/${g}.json`, `${this.#d.service.paths.inbox(set.id)}/superseded/${g}.json`).catch(() => {});
      }
      const bundle = (await this.#bundle(set.id, newest))!;
      const result: GenerationResult = { setId: set.id, incarnation: set.incarnation, generation: newest, status: "applied", items: [] };
      const drtNow = await this.#dest(set.id);
      if (bundle.incarnation !== set.incarnation) Object.assign(result, { status: "rejected", reason: "stale-incarnation" });
      else if (!checkBundle(await this.#hello(), bundle).ok) Object.assign(result, { status: "rejected", reason: "protocol-unsupported" });
      else result.items = await this.#applyBundle(set, bundle, drt);
      // The result is durable first; items.json and appliedGeneration follow. A crash in between is repaired by
      // #reconcile from the durable result on the next start or tick (bookkeeping only, no re-apply).
      result.at = new Date().toISOString();
      await writeResult(this.#d.service.paths, result);
      this.#d.faults?.afterResult?.();
      let n = 0;
      for (const r of result.items) { await this.#saveItem(set.id, r, newest); this.#d.faults?.afterItemSave?.(++n); }
      this.#d.faults?.beforeSaveDest?.();
      // Only an applied result moves the pointer: resume, take-source, rollback and Compare all use the bundle of
      // appliedGeneration, and a rejected bundle must never become that desired state.
      if (result.status === "applied") await this.#saveDest(set.id, { ...drtNow, appliedGeneration: Math.max(drtNow.appliedGeneration, newest) });
    }
    await this.#reapplyPending(set);
  }

  async #applyBundle(set: SetDefinition, bundle: DataBundle, drt: DestinationRuntime, only?: Set<string>): Promise<ItemResult[]> {
    const items = await this.#items(set.id);
    const driver = this.#d.drivers[set.category];
    const out: ItemResult[] = [];
    for (const item of bundle.items) if (!only || only.has(item.key)) out.push(await this.#itemStep(set, bundle.generation, item, items[item.key], drt));
    for (const key of bundle.tombstones) {
      if (only && !only.has(key)) continue;
      const rec = items[key];
      if (drt.detached.includes(key)) out.push({ key, state: "unmanaged", detail: "detached by operator" });
      else if (!rec || rec.baseline === null) { if (rec?.state === "deleted (backup kept)") out.push({ key, state: rec.state }); }
      else if (rec.state === "paused" || OPERATOR_STATES(rec.state)) out.push({ key, state: rec.state, ...(rec.detail ? { detail: rec.detail } : {}) });
      else {
        const v = checkItem(set.category, "remove", this.#facts(), key);
        out.push(v.automatic ? await driver.remove(set, bundle.generation, key) : { key, state: "awaiting-operator", detail: v.reason });
      }
    }
    for (const key of bundle.released) {
      if (only && !only.has(key)) continue;
      const rec = items[key];
      if (rec && rec.state !== "unmanaged") out.push(await driver.release(set, key));
    }
    return out;
  }

  async #itemStep(set: SetDefinition, g: number, item: DesiredItem, rec: ItemRecord | undefined, drt: DestinationRuntime): Promise<ItemResult> {
    if (drt.detached.includes(item.key)) return { key: item.key, state: "unmanaged", detail: "detached by operator", desiredDigest: item.digest };
    // Paused and operator-held items record the newest desired digest but are not applied.
    if (rec && (rec.state === "paused" || OPERATOR_STATES(rec.state))) return { key: item.key, state: rec.state, desiredDigest: item.digest, ...(rec.detail ? { detail: rec.detail } : {}) };
    if (item.category !== set.category) return { key: item.key, state: "blocked: unsafe path", detail: "item category does not match the set", desiredDigest: item.digest };
    const v = checkItem(item.category, "apply", this.#facts(), item.key);
    if (!v.automatic) return { key: item.key, state: "awaiting-operator", detail: v.reason, desiredDigest: item.digest };
    return this.#d.drivers[set.category].apply(set, g, item);
  }

  // Items set back to "pending" (resume, recovery retry) follow the newest applied bundle.
  async #reapplyPending(set: SetDefinition) {
    const drt = await this.#dest(set.id);
    const pending = Object.entries(await this.#items(set.id)).filter(([, r]) => r.state === "pending").map(([k]) => k);
    if (!pending.length) return;
    const bundle = await this.#bundle(set.id, drt.appliedGeneration);
    if (!bundle) return;
    for (const r of await this.#applyBundle(set, bundle, drt, new Set(pending))) await this.#saveItem(set.id, r, bundle.generation);
  }

  // ---- recovery -------------------------------------------------------------------------------------------------

  // For each unfinished journal record: a recorded failure is held for the operator (never retried blindly); otherwise
  // classifyRecovery on the actual state decides. Nothing is rolled forward or back without that evidence.
  // An item whose held or operator state (paused, unmanaged, blocked*, failed, awaiting-operator) was written at or
  // after the record's last write is a decision recovery must not overwrite: the record is skipped and stays
  // unfinished as evidence (a tie counts as newer: ambiguity never overrides a known decision). A record written after
  // that state (a new operation that crashed) is processed normally.
  async #recover(onlySet?: string) {
    const sets = (await this.#d.service.registry.read()).value.sets;
    for (const rec of await this.#d.journal.unfinished()) {
      if (onlySet && rec.setId !== onlySet) continue;
      const cur = (await this.#items(rec.setId))[rec.itemKey];
      if (cur && HELD_STATES(cur.state) && cur.updatedAt >= rec.updatedAt) continue;
      const set = sets.find(s => s.id === rec.setId);
      const driver = this.#d.drivers[set?.category ?? rec.category];
      if (rec.detail?.startsWith("failed:")) {
        await this.#setItemState(rec.setId, rec.itemKey, { state: "failed", detail: `${rec.detail} (journal ${rec.opId}; resolve in Conflicts)` });
        continue;
      }
      const actual = await driver.actualDigest(rec.itemKey);
      const decision = classifyRecovery(rec, actual, { idempotent: driver.idempotent, hasBuild: driver.hasBuild(rec.itemKey) });
      if (decision === "discard-intent" || decision === "retry") {
        await this.#d.journal.advance(rec.opId, "reported", { detail: decision === "retry" ? "closed on recovery: re-applied with a fresh preflight" : "discarded on recovery: nothing was mutated" });
        await this.#setItemState(rec.setId, rec.itemKey, { state: "pending", detail: `recovered (${decision})` });
      } else if (decision === "complete") {
        await this.#setItemState(rec.setId, rec.itemKey, { baseline: rec.desiredDigest, state: rec.op === "delete" ? "deleted (backup kept)" : "in-sync",
          detail: "completed on recovery", ...(rec.desiredDigest ? { actualDigest: rec.desiredDigest } : {}) });
        if (rec.phase !== "verified") await this.#d.journal.advance(rec.opId, "verified");
        await this.#d.journal.advance(rec.opId, "reported", { detail: "completed on recovery" });
      } else {
        await this.#setItemState(rec.setId, rec.itemKey, { state: "blocked: recovery uncertain",
          detail: `journal ${rec.opId} (${rec.op}, phase ${rec.phase}): actual ${actual ?? "absent"}, baseline ${rec.baselineDigest ?? "absent"}, desired ${rec.desiredDigest ?? "absent"}` });
      }
    }
  }

  // ---- operator actions -----------------------------------------------------------------------------------------

  // The item's unfinished records as they stand BEFORE an operator action; only these may be closed by it, and only
  // after the action succeeded, so the action's own record (e.g. a new failure) is never closed by its own success.
  async #priorRecords(setId: string, key: string): Promise<string[]> {
    return (await this.#d.journal.unfinished()).filter(r => r.setId === setId && r.itemKey === key).map(r => r.opId);
  }
  // Closing keeps the evidence: the operator's reason is appended to the record's original detail.
  async #closeJournal(opIds: string[], why: string) {
    const open = new Map((await this.#d.journal.unfinished()).map(r => [r.opId, r]));
    for (const id of opIds) {
      const r = open.get(id);
      if (r) await this.#d.journal.advance(id, "reported", { detail: `closed by operator: ${why}; was: ${r.detail ?? `unfinished at phase ${r.phase}`}` });
    }
  }

  rollback(setId: string, key: string, backupId: string): Promise<ItemResult> {
    return this.enqueue(async () => {
      const set = await this.#set(setId);
      if (!set) return { key, state: "failed", detail: "unknown set" };
      const refused = await this.#guard(setId, key);
      if (refused) return refused;
      const prior = await this.#priorRecords(setId, key);
      const drt = await this.#dest(setId);
      const r = await this.#d.drivers[set.category].restore(set, drt.appliedGeneration, key, backupId);
      const ok = r.state === "in-sync" || r.state === "deleted (backup kept)";
      const out: ItemResult = ok ? { ...r, state: "paused", detail: `rolled back to ${backupId}; resume to follow the source again` } : r;
      // The paused decision is durable before the records it addresses are closed (a crash in between leaves them
      // unfinished, and recovery keeps the newer paused state). A failed rollback closes nothing.
      await this.#saveItem(setId, out);
      if (ok) await this.#closeJournal(prior, `rolled back to ${backupId}`);
      return out;
    });
  }

  resume(setId: string, key: string): Promise<void> {
    return this.enqueue(async () => {
      const rec = (await this.#items(setId))[key];
      if (rec?.state !== "paused" || await this.#guard(setId, key)) return;
      await this.#setItemState(setId, key, { state: "pending", detail: "resumed" });
      const set = await this.#set(setId);
      if (set) await this.#reapplyPending(set);
    });
  }

  resolve(setId: string, key: string, choice: "keep-destination" | "take-source"): Promise<ItemResult> {
    return this.enqueue(async () => {
      const set = await this.#set(setId);
      if (!set) return { key, state: "failed", detail: "unknown set" };
      const refused = await this.#guard(setId, key);
      if (refused) return refused;
      const prior = await this.#priorRecords(setId, key);
      const drt = await this.#dest(setId);
      if (choice === "keep-destination") {
        await this.#saveDest(setId, { ...drt, detached: [...new Set([...drt.detached, key])] });
        const r = await this.#d.drivers[set.category].release(set, key);
        const out: ItemResult = { ...r, state: "unmanaged", detail: "destination copy kept by operator; this item no longer follows the source" };
        await this.#saveItem(setId, out);
        await this.#closeJournal(prior, "keep-destination");
        return out;
      }
      // Nothing is closed or changed unless the source state is actually applied. The item keeps its held state
      // during the apply, so a crash leaves the old decision plus the applier's own (newer) record for recovery.
      const bundle = await this.#bundle(setId, drt.appliedGeneration);
      const item = bundle?.items.find(i => i.key === key);
      if (!item) return { key, state: "failed", detail: "no desired state received for this item yet" };
      const r = await this.#d.drivers[set.category].apply(set, bundle!.generation, item, { acceptDrift: true });
      await this.#saveItem(setId, r, bundle!.generation);
      if (r.state !== "in-sync") return r; // e.g. stale unowned links: still detached, prior records still open
      // Only a validated in-sync apply ends a keep-destination detach, so later generations follow the source again.
      // Released links are never re-adopted here: the applier refuses unowned ones.
      const now = await this.#dest(setId);
      if (now.detached.includes(key)) await this.#saveDest(setId, { ...now, detached: now.detached.filter(k => k !== key) });
      await this.#closeJournal(prior, "take-source");
      return r;
    });
  }

  // One durable write; whichever side of the set this node is reads it (see #paused).
  setPaused(setId: string, paused: boolean): Promise<void> {
    return this.enqueue(async () => { await this.#d.stores.pauses.update(all => ({ ...all, [setId]: paused })); });
  }
  isPaused(setId: string): Promise<boolean> { return this.#paused(setId); }
}
