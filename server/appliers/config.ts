// Daemon config applier and driver (profiles and allowlisted settings), under the section 3 contract: preflight
// comparison against the accepted baseline, durable intent and backup, the narrowest mutation the API allows,
// read-back, baseline before "verified". The window between preflight and mutation is the accepted Q1 risk.
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { BackupStore } from "../backup-store.ts";
import type { Journal } from "../journal.ts";
import type { SessionHolder } from "../session.ts";
import type { CategoryDriver, Snapshot } from "../drivers/skills.ts";
import { digest } from "../canonical.ts";
import { desiredConfigItems, itemValue, parseConfigKey, pickProfile, portableProfile, portableSetting, valueDigest } from "../snapshot/config.ts";
import type { DesiredItem, ItemResult, SetDefinition } from "../../shared/protocol.ts";

export type SkillSelection = { mode: "all" } | { mode: "custom"; skills: string[] };
export interface SelectionSaveResult { selection: SkillSelection; confirmationRequired: { removals: string[] } | null }
// The narrow surface this driver needs. get/patch: PaseoApi.config; saveSkillsSelection: DaemonClient's dedicated
// route (only on the plugin's own session); providers: names listed by providers.snapshot() and not unavailable.
export interface ConfigPort {
  get(): Promise<MutableDaemonConfig>;
  patch(p: MutableDaemonConfigPatch): Promise<MutableDaemonConfig>;
  saveSkillsSelection: ((s: SkillSelection) => Promise<SelectionSaveResult>) | null;
  providers(): Promise<string[]>;
}

export function sessionConfigPort(s: SessionHolder): ConfigPort | null {
  const api = s.get();
  if (!api) return null;
  const extras = s.extras();
  return {
    get: async () => (await api.config.get()).config,
    patch: async p => (await api.config.patch(p)).config,
    // Removals are never confirmed automatically: the daemon then keeps the previous selection and says what it
    // would have deleted (orchestration-skills controller, 0.11.1).
    saveSkillsSelection: extras?.saveSkillsSelection ? sel => extras.saveSkillsSelection!(sel, []) : null,
    providers: async () => (await api.providers.snapshot()).entries
      .filter(e => e.enabled !== false && e.status !== "unavailable").map(e => e.provider),
  };
}

export class ExcludedFieldError extends Error {}
// The mutation for one item, built from the PREFLIGHT read: a profile replaces only its own entry in agentProfiles
// (other entries verbatim, non-portable fields of the managed entry kept); a scalar touches one nested field; an
// array setting is the whole desired array. Excluded or non-allowlisted paths, and skills.selection, throw.
export function buildPatch(current: MutableDaemonConfig, key: string, desired: unknown | undefined): MutableDaemonConfigPatch {
  const k = parseConfigKey(key);
  if ("error" in k) throw new ExcludedFieldError(k.error);
  if (k.kind === "profile") {
    const list = (current.agentProfiles ?? []) as Record<string, unknown>[];
    const i = list.findIndex(p => p.id === k.id);
    const next = list.map(p => ({ ...p }));
    if (desired === undefined) { if (i >= 0) next.splice(i, 1); }
    else {
      const keep = i >= 0 ? Object.fromEntries(Object.entries(list[i]!).filter(([f]) => !(f in pickProfile(list[i]!)))) : {};
      const entry = { ...keep, ...(desired as Record<string, unknown>) };
      if (i >= 0) next[i] = entry; else next.push(entry);
    }
    return { agentProfiles: next } as MutableDaemonConfigPatch;
  }
  if (k.spec.kind === "selection") throw new ExcludedFieldError("skills.selection is not patchable through config.patch (0.11.1)");
  if (desired === undefined) throw new ExcludedFieldError("setting removal not supported by config.patch");
  const out: Record<string, unknown> = {};
  let cur = out;
  const segs = k.path.split(".");
  segs.forEach((seg, n) => { if (n === segs.length - 1) cur[seg] = desired; else { cur[seg] = {}; cur = cur[seg] as Record<string, unknown>; } });
  return out as MutableDaemonConfigPatch;
}

export interface Baselines { get(setId: string, key: string): Promise<string | null>; set(setId: string, key: string, d: string | null): Promise<void> }
export interface ConfigDriverOptions {
  port: () => ConfigPort | null; journal: Journal; backups: BackupStore; baselines: Baselines; revision: () => Promise<number>;
  // Lab-only documentation probe (C6): pause after preflight until the lab releases it. Honoured only for a lab home.
  labPause?: { dir: string } | null;
}

const WAITING = "waiting for Paseo session";
const pending = (key: string, detail = WAITING): ItemResult => ({ key, state: "pending", detail });

export function configDriver(o: ConfigDriverOptions): CategoryDriver {
  // Independent destination validation of an incoming payload: key, allowlist, id, portable fields.
  const validate = (item: DesiredItem): { ok: true; value: unknown } | { ok: false; result: ItemResult } => {
    const k = parseConfigKey(item.key);
    if ("error" in k) return { ok: false, result: { key: item.key, state: "blocked: unsafe path", detail: k.error, desiredDigest: item.digest } };
    const v = k.kind === "profile" ? portableProfile(item.payload as Record<string, unknown>) : portableSetting(k.path, item.payload);
    if (!v.ok) return { ok: false, result: { key: item.key, state: v.state, detail: v.detail, desiredDigest: item.digest } };
    if (k.kind === "profile" && (v.value as { id: string }).id !== k.id) return { ok: false, result: { key: item.key, state: "blocked: unsafe path", detail: "profile id does not match its key", desiredDigest: item.digest } };
    if (digest(v.value) !== item.digest) return { ok: false, result: { key: item.key, state: "blocked: unsafe path", detail: "payload does not match its digest (only portable fields are accepted)", desiredDigest: item.digest } };
    return { ok: true, value: v.value };
  };
  const missingProvider = async (port: ConfigPort, key: string, value: unknown): Promise<string | null> => {
    const k = parseConfigKey(key);
    if ("error" in k) return null;
    const needed = k.kind === "profile" ? [(value as { provider: string }).provider]
      : k.path === "metadataGeneration.providers" ? (value as { provider: string }[]).map(e => e.provider) : [];
    if (!needed.length) return null;
    const have = new Set(await port.providers());
    return needed.find(p => !have.has(p)) ?? null;
  };
  // Handshake, not a sleep: armed by the lab, the driver signals preflight-reached and waits (at most 30 s) for continue.
  const labPause = async () => {
    if (!o.labPause || !existsSync(`${o.labPause.dir}/armed`)) return;
    await rm(`${o.labPause.dir}/armed`, { force: true });
    await writeFile(`${o.labPause.dir}/preflight-reached`, new Date().toISOString());
    for (let i = 0; i < 300 && !existsSync(`${o.labPause.dir}/continue`); i++) await new Promise(r => setTimeout(r, 100));
  };

  // One operation: desired === undefined deletes (profiles only). acceptDrift: operator take-source.
  async function operate(set: SetDefinition, g: number, key: string, desired: unknown | undefined, desiredDigest: string | null,
    opts: { acceptDrift?: boolean } = {}): Promise<ItemResult> {
    const k = parseConfigKey(key);
    if ("error" in k) return { key, state: "blocked: unsafe path", detail: k.error };
    if (desired === undefined && k.kind === "setting") return { key, state: "awaiting-operator", detail: "setting removal not supported by config.patch" };
    const port = o.port();
    if (!port) return pending(key);
    if (k.kind === "setting" && k.spec.kind === "selection" && !port.saveSkillsSelection) return pending(key, `${WAITING} (skills.selection needs the plugin's own daemon session)`);
    const dd = desiredDigest ?? undefined;
    const want = dd ? { desiredDigest: dd } : {};
    if (desired !== undefined) {
      const missing = await missingProvider(port, key, desired);
      if (missing) return { key, state: "blocked: provider missing", detail: `provider ${missing} is not available on this node`, ...want };
    }
    // 1. Preflight.
    const pre = await port.get();
    const before = itemValue(pre, key);
    const actual = valueDigest(before);
    const baseline = await o.baselines.get(set.id, key);
    if (desired === undefined && baseline === null) return { key, state: "unmanaged", detail: "never applied here; nothing deleted" };
    // A profile id that exists here but was never applied by us is an unmanaged collision; a setting always has a
    // value, so the first apply takes it over (backed up first).
    const unmanaged = baseline === null && actual !== null && k.kind === "profile" && actual !== desiredDigest;
    const drift = baseline !== null ? actual !== baseline : unmanaged;
    if (drift && !opts.acceptDrift) return { key, state: "blocked: local change", detail: baseline === null ? "a profile with this id exists here and is not managed" : "changed locally since the last sync",
      ...want, ...(actual ? { actualDigest: actual } : {}) };
    if (actual === desiredDigest && !drift) {
      if (baseline !== actual) await o.baselines.set(set.id, key, actual);
      return desired === undefined ? { key, state: "deleted (backup kept)" } : { key, state: "in-sync", ...want, ...(actual ? { actualDigest: actual } : {}) };
    }
    await labPause();
    // 2. Intent and backup.
    const rec = await o.journal.open({ registryRevision: await o.revision(), setId: set.id, incarnation: set.incarnation, generation: g, itemKey: key,
      category: "config", op: desired === undefined ? "delete" : "apply", baselineDigest: baseline, desiredDigest });
    const backup = await o.backups.saveValue({ setId: set.id, itemKey: key, generation: g, opId: rec.opId, kind: "config-value",
      restorable: "restorable (archived)", digest: actual }, before === undefined ? { absent: true } : { value: before });
    await o.journal.advance(rec.opId, "backed-up", { backupId: backup.backupId });
    // 3. Mutation.
    try {
      if (k.kind === "setting" && k.spec.kind === "selection") {
        const r = await port.saveSkillsSelection!(desired as SkillSelection);
        if (r.confirmationRequired) {
          const removals = r.confirmationRequired.removals.join(", ");
          await o.journal.advance(rec.opId, "reported", { detail: `not applied: the daemon requires confirmation to remove ${removals}` });
          return { key, state: "awaiting-operator", detail: `skills.selection would remove installed skills (${removals}); confirm in Paseo settings`, backupId: backup.backupId, ...want };
        }
      } else await port.patch(buildPatch(pre, key, desired));
    } catch (e) {
      const detail = `patch rejected: ${String(e).slice(0, 200)}`;
      await o.journal.note(rec.opId, `failed: ${detail}`);
      return { key, state: "failed", detail, backupId: backup.backupId, ...want };
    }
    await o.journal.advance(rec.opId, "mutated");
    // 4. Read-back.
    const after = valueDigest(itemValue(await port.get(), key));
    if (after !== desiredDigest) {
      await o.journal.note(rec.opId, "failed: read-back mismatch");
      return { key, state: "failed", detail: `read-back does not match: desired ${desiredDigest ?? "absent"}, actual ${after ?? "absent"}`, backupId: backup.backupId,
        ...want, ...(after ? { actualDigest: after } : {}) };
    }
    // Baseline first: a crash right after "verified" must not leave a verified value that looks unmanaged.
    await o.baselines.set(set.id, key, desiredDigest);
    await o.journal.advance(rec.opId, "verified");
    return desired === undefined ? { key, state: "deleted (backup kept)", backupId: backup.backupId }
      : { key, state: "in-sync", backupId: backup.backupId, ...want, ...(after ? { actualDigest: after } : {}) };
  }

  return {
    idempotent: true,
    hasBuild: () => false,
    async snapshot(set): Promise<Snapshot> {
      const port = o.port();
      if (!port) return { status: "unreadable", reason: WAITING };
      return { status: "ok", ...desiredConfigItems(await port.get(), set.items) };
    },
    async apply(set, g, item, opts) {
      const v = validate(item);
      return v.ok ? operate(set, g, item.key, v.value, item.digest, opts) : v.result;
    },
    remove: (set, g, key) => operate(set, g, key, undefined, null),
    async release(set, key) { await o.baselines.set(set.id, key, null); return { key, state: "unmanaged", detail: "released: un-enrolled at the source; the value is kept" }; },
    async restore(set, g, key, backupId) {
      const saved = await o.backups.readValue(backupId) as { absent?: true; value?: unknown };
      if (saved.absent) return operate(set, g, key, undefined, null);
      const k = parseConfigKey(key);
      if ("error" in k) return { key, state: "blocked: unsafe path", detail: k.error };
      const v = k.kind === "profile" ? portableProfile(saved.value as Record<string, unknown>) : portableSetting(k.path, saved.value);
      if (!v.ok) return { key, state: v.state, detail: `backup not restorable: ${v.detail}` };
      return operate(set, g, key, v.value, digest(v.value));
    },
    async actualDigest(key) {
      const port = o.port();
      if (!port) throw new Error(WAITING); // recovery waits (and is retried) instead of guessing
      return valueDigest(itemValue(await port.get(), key));
    },
  };
}
