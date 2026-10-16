// In-memory daemon config with the 0.11.1 semantics the driver relies on:
// - config.patch deep-merges records key by key and replaces arrays wholesale (F2), and ignores `skills` (P5);
// - saveSkillsSelection applies a selection unless it would remove an installed skill that was not confirmed, in
//   which case it keeps the previous selection and reports confirmationRequired (orchestration-skills controller).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../../server/paths.ts";
import { Journal } from "../../server/journal.ts";
import { BackupStore } from "../../server/backup-store.ts";
import { configDriver, type ConfigPort, type SkillSelection } from "../../server/appliers/config.ts";
import { digest } from "../../server/canonical.ts";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { DesiredItem, SetDefinition } from "../../shared/protocol.ts";

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isRec(v) && isRec(a[k]) ? deepMerge(a[k] as Record<string, unknown>, v) : structuredClone(v);
  return out;
}

export interface FixtureOptions { providers?: string[]; patchDropsProfiles?: boolean; noSession?: boolean; noSelectionRoute?: boolean;
  installedSkills?: string[]; onPatch?: () => void }

export async function makeConfigFixture(initial: Record<string, unknown>, o: FixtureOptions = {}) {
  const home = await mkdtemp(`${tmpdir()}/pns-cfg-`);
  const paths = nodePaths(home);
  let config: Record<string, unknown> = { autoArchiveAfterMerge: false, appendSystemPrompt: "", mcp: { injectIntoAgents: true }, ...structuredClone(initial) };
  let installed = new Set(o.installedSkills ?? []);
  const calls = { patch: [] as MutableDaemonConfigPatch[], selection: [] as SkillSelection[] };
  const port: ConfigPort = {
    async get() { return structuredClone(config) as MutableDaemonConfig; },
    async patch(p) {
      calls.patch.push(structuredClone(p));
      o.onPatch?.();
      let q = structuredClone(p) as Record<string, unknown>;
      delete q.skills; // ignored by 0.11.1 config.patch
      if (o.patchDropsProfiles) delete q.agentProfiles;
      config = deepMerge(config, q);
      return structuredClone(config) as MutableDaemonConfig;
    },
    saveSkillsSelection: o.noSelectionRoute ? null : async sel => {
      calls.selection.push(sel);
      const keep = sel.mode === "all" ? null : new Set(sel.skills);
      const removals = keep ? [...installed].filter(s => !keep.has(s)) : [];
      if (removals.length) return { selection: (config.skills as { selection: SkillSelection } | undefined)?.selection ?? { mode: "all" }, confirmationRequired: { removals } };
      config = { ...config, skills: { selection: sel } };
      if (keep) installed = new Set([...installed].filter(s => keep.has(s)));
      return { selection: sel, confirmationRequired: null };
    },
    providers: async () => o.providers ?? ["claude", "codex"],
  };
  const journal = new Journal(paths), backups = new BackupStore(paths);
  const base = new Map<string, string | null>();
  const baselines = { async get(_s: string, k: string) { return base.get(k) ?? null; }, async set(_s: string, k: string, d: string | null) { base.set(k, d); } };
  const driver = configDriver({ port: () => (o.noSession ? null : port), journal, backups, baselines, revision: async () => 1 });
  const set: SetDefinition = { id: "cfg", incarnation: "incarnation-1", source: "home", destination: "work", category: "config", items: [], createdAt: "t" };
  let g = 0;
  const item = (key: string, payload: unknown): DesiredItem => ({ key, category: "config", digest: digest(payload), payload });
  return {
    home, paths, port, journal, backups, baselines: base, driver, set, calls,
    get config() { return config; },
    setConfig(c: Record<string, unknown>) { config = c; },
    applyProfile: (p: Record<string, unknown>, opts?: { acceptDrift?: boolean }) => driver.apply(set, ++g, item(`profile:${p.id}`, p), opts),
    applySetting: (path: string, v: unknown) => driver.apply(set, ++g, item(`setting:${path}`, v)),
    applyRaw: (it: DesiredItem) => driver.apply(set, ++g, it),
    deleteProfile: (id: string) => driver.remove(set, ++g, `profile:${id}`),
    deleteSetting: (path: string) => driver.remove(set, ++g, `setting:${path}`),
  };
}
