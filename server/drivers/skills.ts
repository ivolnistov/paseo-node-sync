// Skills category driver: snapshot on the source, apply/remove/release/restore on the destination. Baselines and
// discovery-link ownership are durable (items.json, links.json); every mutation goes through the Task 4 applier.
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type { BackupStore } from "../backup-store.ts";
import type { Journal } from "../journal.ts";
import type { NodePaths } from "../paths.ts";
import type { Stores, ItemRecord } from "../state.ts";
import { applySkill, deleteSkill, actualSkillDigest, managedSkillsRoot, type SkillsApplyContext, type ApplyHooks } from "../appliers/skills.ts";
import { buildSkill, manifestDigest, resolveRoot, type SkillPayload } from "../snapshot/skills.ts";
import type { DesiredItem, ItemResult, SetDefinition } from "../../shared/protocol.ts";

export type Snapshot = { status: "ok"; items: DesiredItem[]; missing: string[]; blocked: { key: string; detail: string }[] } | { status: "unreadable"; reason: string };
export interface CategoryDriver {
  snapshot(set: SetDefinition): Promise<Snapshot>;
  apply(set: SetDefinition, g: number, item: DesiredItem, opts?: { acceptDrift?: boolean }): Promise<ItemResult>;
  remove(set: SetDefinition, g: number, key: string): Promise<ItemResult>;
  release(set: SetDefinition, key: string): Promise<ItemResult>;
  restore(set: SetDefinition, g: number, key: string, backupId: string): Promise<ItemResult>;
  actualDigest(key: string): Promise<string | null>;
  idempotent: boolean; hasBuild(key: string): boolean;
}

const nameOf = (key: string) => key.slice("skill:".length);
const setRef = (s: SetDefinition, revision: number) => ({ id: s.id, incarnation: s.incarnation, revision });

export interface SkillsDriverOptions { paths: NodePaths; stores: Stores; journal: Journal; backups: BackupStore; discoveryDirs: string[];
  revision: () => Promise<number>; hooks?: ApplyHooks }

export class SkillsDriver implements CategoryDriver {
  readonly idempotent = true;
  #o: SkillsDriverOptions;
  constructor(o: SkillsDriverOptions) { this.#o = o; }
  hasBuild(_key: string) { return false; }

  // Context for one operation: baselines and owned links loaded from disk, written through on change.
  async #ctx(setId: string): Promise<SkillsApplyContext> {
    const items = (await this.#o.stores.items.read()).value[setId] ?? {};
    const baselines = new Map(Object.entries(items).map(([k, r]) => [k, r.baseline]));
    const links = new Set((await this.#o.stores.links.read()).value);
    const { stores } = this.#o;
    return { paths: this.#o.paths, journal: this.#o.journal, backups: this.#o.backups, discoveryDirs: this.#o.discoveryDirs,
      ...(this.#o.hooks ? { hooks: this.#o.hooks } : {}),
      baselines: { get: k => baselines.get(k) ?? null, set: async (k, d) => {
        baselines.set(k, d);
        await stores.items.update(all => {
          const prev: ItemRecord = all[setId]?.[k] ?? { state: "pending", baseline: null, updatedAt: new Date().toISOString() };
          return { ...all, [setId]: { ...(all[setId] ?? {}), [k]: { ...prev, baseline: d } } };
        });
      } },
      owners: { owns: l => links.has(l),
        record: async l => { links.add(l); await stores.links.update(all => all.includes(l) ? all : [...all, l]); },
        forget: async l => { links.delete(l); await stores.links.update(all => all.filter(x => x !== l)); } } };
  }

  // Each enrolled skill belongs to the recorded root whose realpath contains it. A root that is missing or retargeted
  // makes the whole snapshot unreadable: no tombstones can come from an unreadable source.
  async snapshot(set: SetDefinition): Promise<Snapshot> {
    const roots = (await this.#o.stores.roots.read()).value[set.id] ?? [];
    const items: DesiredItem[] = [], missing: string[] = [], blocked: { key: string; detail: string }[] = [];
    for (const r of roots) {
      const ok = await resolveRoot(r.path, r.realpath);
      if ("error" in ok) return { status: "unreadable", reason: `root ${r.path} ${ok.error}` };
    }
    for (const e of set.items) {
      const name = nameOf(e.key);
      const dir = e.resource.slice("skill:".length);
      const root = roots.find(r => r.realpath === dirname(dir));
      if (!root) return { status: "unreadable", reason: `no recorded root on this node for ${e.key}` };
      if (!(await lstat(dir).then(() => true, () => false))) { missing.push(e.key); continue; }
      const built = await buildSkill({ path: root.path, realpath: root.realpath }, name, true);
      if ("blocked" in built) blocked.push({ key: e.key, detail: built.detail });
      else items.push({ key: e.key, category: "skills", digest: built.digest, payload: built.payload });
    }
    return { status: "ok", items, missing, blocked };
  }

  async apply(set: SetDefinition, g: number, item: DesiredItem, opts: { acceptDrift?: boolean } = {}) {
    return applySkill(await this.#ctx(set.id), setRef(set, await this.#o.revision()), g, item, opts);
  }
  async remove(set: SetDefinition, g: number, key: string) {
    return deleteSkill(await this.#ctx(set.id), setRef(set, await this.#o.revision()), g, key);
  }
  // Un-enrolled at the source: the destination copy stays, unmanaged. Our links stop being "ours".
  async release(set: SetDefinition, key: string): Promise<ItemResult> {
    const ctx = await this.#ctx(set.id);
    const root = await managedSkillsRoot(this.#o.paths, { create: false });
    for (const d of this.#o.discoveryDirs) { const l = `${d}/${nameOf(key)}`; if (ctx.owners.owns(l)) await ctx.owners.forget(l); }
    await ctx.baselines.set(key, null);
    return { key, state: "unmanaged", detail: `released: un-enrolled at the source; the copy${root.ok ? "" : " (managed root unsafe)"} is kept` };
  }
  actualDigest(key: string) { return this.#ctx("_").then(ctx => actualSkillDigest(ctx, nameOf(key))); }

  // Rollback re-applies a backup as a validated payload through the normal applier (root guard, drift check against
  // the baseline, backup of the current copy, swap, read-back). It never writes to an arbitrary target.
  async restore(set: SetDefinition, g: number, key: string, backupId: string): Promise<ItemResult> {
    const meta = (await this.#o.backups.list(set.id, key)).find(b => b.backupId === backupId);
    if (!meta || meta.kind !== "skill-dir") return { key, state: "failed", detail: "backup not found for this item" };
    const payloadDir = await this.#o.backups.payloadDir(backupId);
    if (payloadDir === null) return this.remove(set, g, key);
    const built = await buildSkill({ path: dirname(payloadDir), realpath: dirname(payloadDir) }, "payload", true);
    if ("blocked" in built) return { key, state: "blocked: unsafe path", detail: `backup content unsafe: ${built.detail}` };
    const payload: SkillPayload = { name: nameOf(key), files: built.payload.files };
    const digest = manifestDigest(payload.name, payload.files);
    if (digest !== meta.digest) return { key, state: "failed", detail: "backup content does not match its recorded digest" };
    return this.apply(set, g, { key, category: "skills", digest, payload });
  }
}

// Categories assigned to later tasks: every item is held for the operator, nothing is applied or claimed.
export class UnsupportedDriver implements CategoryDriver {
  readonly idempotent = false;
  #reason: string;
  constructor(reason: string) { this.#reason = reason; }
  hasBuild(_key: string) { return false; }
  async snapshot(): Promise<Snapshot> { return { status: "unreadable", reason: this.#reason }; }
  async apply(_s: SetDefinition, _g: number, item: DesiredItem): Promise<ItemResult> { return { key: item.key, state: "awaiting-operator", detail: this.#reason }; }
  async remove(_s: SetDefinition, _g: number, key: string): Promise<ItemResult> { return { key, state: "awaiting-operator", detail: this.#reason }; }
  async release(_s: SetDefinition, key: string): Promise<ItemResult> { return { key, state: "awaiting-operator", detail: this.#reason }; }
  async restore(_s: SetDefinition, _g: number, key: string): Promise<ItemResult> { return { key, state: "awaiting-operator", detail: this.#reason }; }
  async actualDigest() { return null; }
}
