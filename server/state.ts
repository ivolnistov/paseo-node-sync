// Durable node-local engine state, all under <PASEO_HOME>/node-sync (DocStore: revisioned, atomic, locked).
import { DocStore } from "./store.ts";
import type { NodePaths } from "./paths.ts";
import type { DataBundle, GenerationResult, RegistryOutcome } from "../shared/protocol.ts";
import type { ItemState, SetState } from "../shared/states.ts";

export interface ItemRecord { state: ItemState; detail?: string; baseline: string | null; desiredDigest?: string; actualDigest?: string;
  backupId?: string; generation?: number; updatedAt: string }
// Source side of one set. pending: newest generation built (outbox) and not yet acknowledged; putAccepted: the
// generation the destination has accepted, so a lost fetch-result is fetched again without another put.
export interface SourceRuntime { incarnation?: string; lastGeneration: number; lastDigest: string | null; pending: number | null; putAccepted: number;
  ackedGeneration: number; lastResult: GenerationResult | null; sentKeys: string[]; releasePending: string[]; attempt: number; nextRetryAt: number;
  state: SetState; detail?: string; paused?: boolean; identityPin?: string; sourceItems: Record<string, { state: ItemState; detail?: string }>;
  // The last delivery failure, kept apart from state so a source problem (source-unreadable) and a transport problem
  // are both visible; cleared on a successful acknowledgement.
  delivery?: { state: SetState; detail: string } }
export interface DestinationRuntime { appliedGeneration: number; detached: string[]; paused: boolean }
export interface RootRecord { path: string; realpath: string }
export interface ReplicationRecord { acked: number; attempts: number; nextRetryAt: number; lastError?: string; lastAttemptAt?: string }
export interface FollowerRequest { requestId: string; op: string; summary: string; baseRevision: number; status: "requested" | "applied" | "rejected";
  error?: string; revision?: number; sentAt: string; settledAt?: string; attempts: number; nextRetryAt: number }

export const emptySource = (): SourceRuntime => ({ lastGeneration: 0, lastDigest: null, pending: null, putAccepted: 0, ackedGeneration: 0,
  lastResult: null, sentKeys: [], releasePending: [], attempt: 0, nextRetryAt: 0, state: "idle", sourceItems: {} });

export class Stores {
  readonly items: DocStore<Record<string, Record<string, ItemRecord>>>;
  readonly sources: DocStore<Record<string, SourceRuntime>>;
  readonly destinations: DocStore<Record<string, DestinationRuntime>>;
  readonly links: DocStore<string[]>;
  readonly roots: DocStore<Record<string, RootRecord[]>>;
  readonly replication: DocStore<Record<string, ReplicationRecord>>;
  readonly registryResults: DocStore<Record<string, RegistryOutcome>>;
  readonly requests: DocStore<Record<string, FollowerRequest>>;
  // The single authoritative operator pause per set, consulted by both the source and the destination step. It does
  // not depend on any runtime record existing, so a set can be paused before its first sync.
  readonly pauses: DocStore<Record<string, boolean>>;
  readonly paths: NodePaths;
  constructor(paths: NodePaths) {
    this.paths = paths;
    this.items = new DocStore(paths.items, {});
    this.sources = new DocStore(`${paths.root}/sources.json`, {});
    this.destinations = new DocStore(`${paths.root}/destinations.json`, {});
    this.links = new DocStore(`${paths.root}/links.json`, []);
    this.roots = new DocStore(`${paths.root}/roots.json`, {});
    this.replication = new DocStore(`${paths.root}/replication.json`, {});
    this.registryResults = new DocStore(`${paths.root}/registry-results.json`, {});
    this.requests = new DocStore(`${paths.root}/requests.json`, {});
    this.pauses = new DocStore(`${paths.root}/pauses.json`, {});
  }
  outbox(setId: string, g: number) { return `${this.paths.root}/outbox/${setId}/${g}.json`; }
}

// Accepted baselines (digest of the last value this node applied and read back), kept in items.json per set.
export function itemBaselines(stores: Stores) {
  return {
    async get(setId: string, key: string): Promise<string | null> { return (await stores.items.read()).value[setId]?.[key]?.baseline ?? null; },
    async set(setId: string, key: string, d: string | null): Promise<void> {
      await stores.items.update(all => {
        const prev: ItemRecord = all[setId]?.[key] ?? { state: "pending", baseline: null, updatedAt: new Date().toISOString() };
        return { ...all, [setId]: { ...(all[setId] ?? {}), [key]: { ...prev, baseline: d } } };
      });
    },
  };
}

export type { DataBundle };
