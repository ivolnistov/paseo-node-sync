// Registry of sync sets. One node (the home Mac) owns it; the follower only ever stores what the owner
// replicates. A received registry names sets but admits nothing: admission is a local peer-binding action.
import { bundleDigest } from "./canonical.ts";
import type { DocStore } from "./store.ts";
import { PROTOCOL_VERSION, type Category, type Registry, type RegistryBundle, type RegistryChange, type RegistryRequestBundle,
  type SetDefinition } from "../shared/protocol.ts";

export const SELF_PLUGIN_ID = "paseo-node-sync";

export interface RegistryDeps {
  store: DocStore<Registry>; node: { nodeId: string; role: "owner" | "follower" };
  pushToOwner(b: RegistryRequestBundle): Promise<void>; replicate(r: Registry): Promise<void>;
  newIncarnation(): string; now(): string; newRequestId(): string;
}

export type ChangeError = "overlap" | "unknown-set" | "self-plugin" | "managed-elsewhere" | "duplicate-set" | "category-mismatch" | "invalid-set";

// Item keys a category may hold; key/category disagreement is rejected so a set can never smuggle another kind.
const KEY_PREFIX: Record<Category, string[]> = { skills: ["skill:"], config: ["profile:", "setting:"], plugins: ["plugin:"] };

// Canonical resource identity: settings overlap on dotted-path prefix and on x vs x[0]; everything else
// (skill realpaths, profile ids, plugin ids) only on equality within the same kind.
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("setting:") || !b.startsWith("setting:")) return false;
  const [x, y] = [a.slice(8), b.slice(8)];
  const under = (p: string, q: string) => p.startsWith(q) && (p[q.length] === "." || p[q.length] === "[");
  return under(x, y) || under(y, x);
}

function itemsValid(category: Category, items: { key: string; resource: string }[]): ChangeError | null {
  for (const i of items) {
    if (i.key === `plugin:${SELF_PLUGIN_ID}` || i.resource === `plugin:${SELF_PLUGIN_ID}`) return "self-plugin";
    if (!KEY_PREFIX[category].some(p => i.key.startsWith(p))) return "category-mismatch";
  }
  return null;
}

function conflicts(sets: SetDefinition[], resources: string[], exceptSet?: string): boolean {
  for (const s of sets) {
    if (s.id === exceptSet) continue;
    for (const i of s.items) if (resources.some(r => overlaps(r, i.resource))) return true;
  }
  return false;
}

export function applyChange(r: Registry, c: RegistryChange, now: string, newIncarnation: () => string):
  { ok: true; registry: Registry } | { ok: false; error: ChangeError } {
  const sets = r.sets.map(s => ({ ...s, items: [...s.items] }));
  const next = (): { ok: true; registry: Registry } => ({ ok: true, registry: { ...r, revision: r.revision + 1, sets } });
  switch (c.op) {
    case "create-set": {
      if (sets.some(s => s.id === c.set.id)) return { ok: false, error: "duplicate-set" };
      if (c.set.source === c.set.destination) return { ok: false, error: "invalid-set" };
      const bad = itemsValid(c.set.category, c.set.items);
      if (bad) return { ok: false, error: bad };
      const resources = c.set.items.map(i => i.resource);
      if (new Set(resources).size !== resources.length || conflicts(sets, resources)) return { ok: false, error: "overlap" };
      sets.push({ ...c.set, items: [...c.set.items], incarnation: newIncarnation(), createdAt: now });
      return next();
    }
    case "delete-set": {
      const i = sets.findIndex(s => s.id === c.setId);
      if (i < 0) return { ok: false, error: "unknown-set" };
      sets.splice(i, 1);
      return next();
    }
    case "enroll": {
      const s = sets.find(x => x.id === c.setId);
      if (!s) return { ok: false, error: "unknown-set" };
      const bad = itemsValid(s.category, [c.item]);
      if (bad) return { ok: false, error: bad };
      if (s.items.some(i => i.key === c.item.key || overlaps(i.resource, c.item.resource)) || conflicts(sets, [c.item.resource], s.id))
        return { ok: false, error: "overlap" };
      s.items.push(c.item);
      return next();
    }
    case "unenroll": {
      const s = sets.find(x => x.id === c.setId);
      if (!s) return { ok: false, error: "unknown-set" };
      s.items = s.items.filter(i => i.key !== c.key);
      return next();
    }
  }
}

// Owner: apply, persist (revision + 1), replicate. Follower: never mutates; sends the change to the owner.
export async function requestChange(d: RegistryDeps, c: RegistryChange):
  Promise<{ status: "applied"; revision: number } | { status: "requested"; requestId: string } | { status: "rejected"; error: string }> {
  if (d.node.role === "follower") {
    const current = await d.store.read();
    const body = { kind: "registry-request" as const, protocol: PROTOCOL_VERSION, requestId: d.newRequestId(), baseRevision: current.value.revision, change: c };
    try { await d.pushToOwner({ ...body, digest: bundleDigest(body) }); }
    catch { return { status: "rejected", error: "owner-unreachable" }; }
    return { status: "requested", requestId: body.requestId };
  }
  let outcome: { ok: true; registry: Registry } | { ok: false; error: ChangeError } = { ok: false, error: "unknown-set" };
  const saved = await d.store.update(current => {
    outcome = applyChange(current, c, d.now(), () => d.newIncarnation());
    return outcome.ok ? outcome.registry : current;
  });
  if (!outcome.ok) return { status: "rejected", error: outcome.error };
  // Replication failures do not undo the change; the next replication carries the newest revision.
  await d.replicate(saved.value).catch(() => {});
  return { status: "applied", revision: saved.value.revision };
}

export async function receiveRegistry(d: RegistryDeps, b: RegistryBundle): Promise<{ status: "stored" | "ignored-older" }> {
  let stored = false;
  await d.store.update(current => {
    if (b.registry.revision <= current.revision) return current;
    stored = true;
    return b.registry;
  });
  return { status: stored ? "stored" : "ignored-older" };
}
