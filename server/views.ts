// Read models and local operator actions behind the Enroll, Conflicts and History screens.
import { readdir, readFile } from "node:fs/promises";
import type { NodeSyncService } from "./service.ts";
import type { Stores } from "./state.ts";
import type { BackupStore } from "./backup-store.ts";
import { buildSkill, resolveRoot, scanRoot, within, SAFE_SEGMENT } from "./snapshot/skills.ts";
import { managedSkillsRoot } from "./appliers/skills.ts";
import type { DataBundle, GenerationResult } from "../shared/protocol.ts";
import type { ConfigPort } from "./appliers/config.ts";
import { SETTINGS_ALLOWLIST, parseConfigKey, pickProfile, portableProfile, portableSetting, readPath, valueDigest } from "./snapshot/config.ts";

export class Views {
  #s: NodeSyncService; #stores: Stores; #backups: BackupStore; #config: () => ConfigPort | null;
  constructor(service: NodeSyncService, stores: Stores, backups: BackupStore, config: () => ConfigPort | null = () => null) {
    this.#s = service; this.#stores = stores; this.#backups = backups; this.#config = config;
  }

  // Profiles and allowlisted settings of this (source) node. Excluded fields are never listed.
  async #configTree(setId: string, set: { items: { key: string }[] }) {
    const port = this.#config();
    if (!port) return { ok: true as const, setId, category: "config", roots: [], candidates: [{ key: "config:*", label: "daemon config", root: "", enrolled: false, preview: [],
      unavailable: "waiting for Paseo session" }] };
    const config = await port.get();
    const sets = (await this.#s.registry.read()).value.sets;
    const states = (await this.#stores.sources.read()).value[setId]?.sourceItems ?? {};
    const common = (key: string) => {
      const other = sets.find(s => s.id !== setId && s.items.some(i => i.key === key));
      return { key, root: "", enrolled: set.items.some(i => i.key === key), preview: [] as string[], ...(other ? { managedBySet: other.id } : {}),
        ...(states[key] ? { state: states[key].state } : {}) };
    };
    const candidates = [];
    for (const p of (config.agentProfiles ?? []) as Record<string, unknown>[]) {
      const v = portableProfile(p);
      candidates.push({ ...common(`profile:${String(p.id)}`), label: `Profile ${String(p.name)} (${String(p.provider)})`,
        value: JSON.stringify(pickProfile(p)).slice(0, 400), ...(v.ok ? {} : { blocked: v.detail }) });
    }
    for (const [path, spec] of Object.entries(SETTINGS_ALLOWLIST)) {
      const raw = readPath(config, path);
      if (raw === undefined) continue;
      const v = portableSetting(path, raw);
      candidates.push({ ...common(`setting:${path}`), label: path, advanced: spec.advanced, value: JSON.stringify(raw).slice(0, 400),
        ...(spec.preview === "full" && typeof raw === "string" ? { fullText: raw } : {}), valueDigest: valueDigest(raw) ?? "",
        ...(v.ok ? {} : { blocked: v.detail }) });
    }
    return { ok: true as const, setId, category: "config", roots: [], candidates };
  }

  async #set(setId: string) { return (await this.#s.registry.read()).value.sets.find(s => s.id === setId) ?? null; }

  // A root is local to the source node. It is trusted once by the operator, recorded with its realpath, and may not
  // lie inside this node's managed tree (an applied copy can never become a source: no loops).
  async addRoot(setId: string, path: string, confirmTrust: boolean) {
    const node = await this.#s.node(), set = await this.#set(setId);
    if (!node || !set) return { ok: false as const, error: "unknown-set" };
    if (set.source !== node.nodeId) return { ok: false as const, error: "not-source", detail: "roots are added on the set's source node" };
    if (set.category !== "skills") return { ok: false as const, error: "unsupported-category" };
    if (!confirmTrust) return { ok: false as const, error: "trust-not-confirmed", detail: "confirm that files under this root may be sent" };
    if (!path.startsWith("/")) return { ok: false as const, error: "invalid-path" };
    const r = await resolveRoot(path);
    if ("error" in r) return { ok: false as const, error: `root-${r.error}` };
    const managed = await managedSkillsRoot(this.#s.paths, { create: false });
    if (within(this.#s.paths.root, r.realpath) || within(r.realpath, this.#s.paths.root) || (managed.ok && within(managed.dir, r.realpath)))
      return { ok: false as const, error: "managed-tree", detail: "a root may not contain or lie inside the node-sync state" };
    await this.#stores.roots.update(all => ({ ...all, [setId]: [...(all[setId] ?? []).filter(x => x.realpath !== r.realpath), { path, realpath: r.realpath }] }));
    return { ok: true as const, realpath: r.realpath };
  }

  async enrollTree(setId: string) {
    const set = await this.#set(setId);
    if (!set) return { ok: false as const, error: "unknown-set" };
    if (set.category === "config") return this.#configTree(setId, set);
    if (set.category !== "skills")
      return { ok: true as const, setId, category: set.category, roots: [], candidates: [{ key: `${set.category}:*`, label: set.category, root: "", enrolled: false, preview: [],
        unavailable: set.category === "plugins" ? "plugin sync arrives in Task 7; cross-plugin settings are not supported" : "config sync arrives in Task 6" }] };
    const sets = (await this.#s.registry.read()).value.sets;
    const roots = (await this.#stores.roots.read()).value[setId] ?? [];
    const states = (await this.#stores.sources.read()).value[setId]?.sourceItems ?? {};
    const outRoots = [], candidates = [];
    for (const r of roots) {
      const scan = await scanRoot(r);
      outRoots.push({ path: r.path, realpath: r.realpath, readable: scan.status === "ok", ...(scan.status === "unreadable" ? { reason: scan.reason } : {}) });
      if (scan.status !== "ok") continue;
      for (const sk of scan.skills) {
        const key = `skill:${sk.name}`, resource = `skill:${r.realpath}/${sk.name}`;
        const other = sets.find(s => s.id !== setId && s.items.some(i => i.resource === resource));
        const built = sk.problems.length ? null : await buildSkill(r, sk.name, false);
        candidates.push({ key, label: sk.name, root: r.realpath, enrolled: set.items.some(i => i.key === key),
          ...(other ? { managedBySet: other.id } : {}), ...(sk.problems.length ? { blocked: sk.problems.join("; ") } : {}),
          preview: built && "payload" in built ? built.payload.files.map(f => f.rel).slice(0, 50) : [], ...(states[key] ? { state: states[key].state } : {}) });
      }
    }
    return { ok: true as const, setId, category: set.category, roots: outRoots, candidates };
  }

  async enroll(setId: string, key: string, enrolled: boolean, root?: string, o: { confirmAdvanced?: boolean; previewDigest?: string } = {}) {
    if (!enrolled) return this.#s.change({ op: "unenroll", setId, key });
    const set = await this.#set(setId);
    if (set?.category === "config") {
      const k = parseConfigKey(key);
      if ("error" in k) return { status: "rejected" as const, error: `not-enrollable: ${k.error}` };
      if (k.kind === "setting") {
        if (k.spec.advanced && !o.confirmAdvanced) return { status: "rejected" as const, error: "advanced-not-confirmed" };
        if (k.spec.preview === "full") {
          const port = this.#config();
          if (!port) return { status: "rejected" as const, error: "waiting for Paseo session" };
          if (!o.previewDigest || o.previewDigest !== valueDigest(readPath(await port.get(), k.path))) return { status: "rejected" as const, error: "preview-required: open the full text first" };
        }
      }
      return this.#s.change({ op: "enroll", setId, item: { key, resource: key } });
    }
    const name = key.startsWith("skill:") ? key.slice(6) : "";
    const roots = (await this.#stores.roots.read()).value[setId] ?? [];
    const r = roots.find(x => x.realpath === root) ?? (roots.length === 1 ? roots[0] : undefined);
    if (!r || !SAFE_SEGMENT.test(name)) return { status: "rejected" as const, error: "unknown-root-or-item" };
    return this.#s.change({ op: "enroll", setId, item: { key, resource: `skill:${r.realpath}/${name}` } });
  }

  async #latestBundle(setId: string): Promise<DataBundle | null> {
    const g = (await this.#stores.destinations.read()).value[setId]?.appliedGeneration ?? 0;
    if (!g) return null;
    const dir = this.#s.paths.inbox(setId);
    const text = await readFile(`${dir}/${g}.json`, "utf8").catch(() => readFile(`${dir}/superseded/${g}.json`, "utf8").catch(() => null));
    return text ? JSON.parse(text) as DataBundle : null;
  }

  // Items held for the operator, with a file-level comparison of the newest desired state and the managed copy.
  async conflicts() {
    const all = (await this.#stores.items.read()).value;
    const out = [];
    const managed = await managedSkillsRoot(this.#s.paths, { create: false });
    for (const [setId, items] of Object.entries(all)) for (const [key, r] of Object.entries(items)) {
      if (!(r.state.startsWith("blocked") || r.state === "failed" || r.state === "awaiting-operator")) continue;
      let compare: { added: string[]; removed: string[]; changed: string[] } | undefined;
      const desired = (await this.#latestBundle(setId))?.items.find(i => i.key === key);
      if (desired && key.startsWith("skill:") && managed.ok && managed.exists) {
        const actual = await buildSkill({ path: managed.dir, realpath: managed.dir }, key.slice(6), false);
        const want = new Map((desired.payload as { files: { rel: string; digest: string }[] }).files.map(f => [f.rel, f.digest]));
        const have = new Map("payload" in actual ? actual.payload.files.map(f => [f.rel, f.digest]) : []);
        compare = { added: [...want.keys()].filter(k => !have.has(k)), removed: [...have.keys()].filter(k => !want.has(k)),
          changed: [...want.keys()].filter(k => have.has(k) && have.get(k) !== want.get(k)) };
      }
      out.push({ setId, key, state: r.state, ...(r.detail ? { detail: r.detail } : {}), ...(r.desiredDigest ? { desiredDigest: r.desiredDigest } : {}),
        ...(r.actualDigest ? { actualDigest: r.actualDigest } : {}), ...(compare ? { compare } : {}) });
    }
    return { conflicts: out.slice(0, 200) };
  }

  async history(setId?: string) {
    const sets = (await this.#s.registry.read()).value.sets.filter(s => !setId || s.id === setId);
    const node = await this.#s.node();
    const generations: { setId: string; side: "source" | "destination"; generation: number; status: string; supersededBy?: number; items: GenerationResult["items"] }[] = [];
    const backups = [];
    const items = [];
    for (const s of sets) {
      if (s.destination === node?.nodeId) {
        const dir = `${this.#s.paths.root}/results/${s.id}`;
        for (const f of (await readdir(dir).catch(() => [] as string[])).filter(x => /^\d+\.json$/.test(x))) {
          const r = JSON.parse(await readFile(`${dir}/${f}`, "utf8")) as GenerationResult;
          if (r.incarnation === s.incarnation) generations.push({ setId: s.id, side: "destination", generation: r.generation, status: r.status,
            ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}), items: r.items });
        }
        for (const [key, r] of Object.entries((await this.#stores.items.read()).value[s.id] ?? {})) {
          items.push({ setId: s.id, key, state: r.state, ...(r.detail ? { detail: r.detail } : {}), ...(r.backupId ? { backupId: r.backupId } : {}),
            ...(r.generation ? { generation: r.generation } : {}) });
          for (const b of await this.#backups.list(s.id, key)) backups.push({ setId: s.id, key, backupId: b.backupId, generation: b.generation,
            restorable: b.restorable, digest: b.digest, createdAt: b.createdAt });
        }
      }
      if (s.source === node?.nodeId) {
        const rt = (await this.#stores.sources.read()).value[s.id];
        if (rt?.lastResult) generations.push({ setId: s.id, side: "source", generation: rt.lastResult.generation, status: rt.lastResult.status, items: rt.lastResult.items });
      }
    }
    generations.sort((a, b) => b.generation - a.generation);
    backups.sort((a, b) => b.generation - a.generation || b.createdAt.localeCompare(a.createdAt));
    return { generations: generations.slice(0, 50), backups: backups.slice(0, 200), items: items.slice(0, 500) };
  }

  async runtime() {
    const node = await this.#s.node();
    const sets = (await this.#s.registry.read()).value.sets;
    const src = (await this.#stores.sources.read()).value, dst = (await this.#stores.destinations.read()).value;
    const pauses = (await this.#stores.pauses.read()).value;
    const out = [];
    for (const s of sets) {
      // The pause store is authoritative; runtime flags count only for a set it has never recorded.
      const paused = pauses[s.id] ?? (!!src[s.id]?.paused || !!dst[s.id]?.paused);
      if (s.source === node?.nodeId) { const r = src[s.id]; out.push({ setId: s.id, side: "source" as const, state: paused ? "paused" : r?.state ?? "idle",
        ...(r?.detail ? { detail: r.detail } : {}), ...(r?.delivery ? { delivery: r.delivery } : {}), generation: r?.ackedGeneration ?? 0, paused }); }
      if (s.destination === node?.nodeId) { const r = dst[s.id]; out.push({ setId: s.id, side: "destination" as const, state: paused ? "paused" : "idle",
        generation: r?.appliedGeneration ?? 0, paused }); }
    }
    return out.slice(0, 100);
  }
}
