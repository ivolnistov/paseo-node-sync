// Daemon config category: which profiles and settings may travel, in what shape, and the portable projection of each.
// Shapes follow MutableDaemonConfig of @getpaseo/protocol 0.11.1 (read from the installed SDK in the lab image).
// The same validation runs on the source (snapshot) and independently on the destination (incoming payloads).
import { digest } from "../canonical.ts";
import type { DesiredItem, EnrolledItem } from "../../shared/protocol.ts";

export const PROFILE_FIELDS = ["id", "name", "icon", "color", "provider", "model", "modeId", "thinkingOptionId", "featureValues", "notes"] as const;

// kind: scalar → patched as one nested field; array → replaced wholesale (F2); selection → the dedicated
// saveAgentSkillsSelection route (config.patch ignores skills in 0.11.1, probe P5). advanced: explicit opt-in.
// preview: "full" → the whole text must be shown before enrolling (appendSystemPrompt).
export interface SettingSpec { kind: "scalar" | "array" | "selection"; type: "boolean" | "string" | "metadataProviders" | "terminalProfiles" | "selection";
  advanced: boolean; preview?: "full" }
export const SETTINGS_ALLOWLIST: Record<string, SettingSpec> = {
  "autoArchiveAfterMerge": { kind: "scalar", type: "boolean", advanced: false },
  "enableTerminalAgentHooks": { kind: "scalar", type: "boolean", advanced: false },
  "appendSystemPrompt": { kind: "scalar", type: "string", advanced: false, preview: "full" },
  "mcp.injectIntoAgents": { kind: "scalar", type: "boolean", advanced: false },
  "browserTools.enabled": { kind: "scalar", type: "boolean", advanced: false },
  "metadataGeneration.providers": { kind: "array", type: "metadataProviders", advanced: true },
  "terminalProfiles": { kind: "array", type: "terminalProfiles", advanced: true },
  "skills.selection": { kind: "selection", type: "selection", advanced: true },
};
// Account scope, launch override, trust switch, CLI-owned: never offered, never written.
export const EXCLUDED_PREFIXES = ["providers", "removeProviders", "relay", "pluginsEnabled", "plugins"];

export const MAX_TEXT = 20_000;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOME_PATH = /^(\/(Users|home)\/[^/]+\/|\/root\/|~\/)/;

export type ConfigKey = { kind: "profile"; id: string } | { kind: "setting"; path: string; spec: SettingSpec };
export function excluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some(p => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
}
export function parseConfigKey(key: string): ConfigKey | { error: string } {
  if (key.startsWith("profile:")) {
    const id = key.slice(8);
    return PROFILE_ID.test(id) ? { kind: "profile", id } : { error: `invalid profile id in ${JSON.stringify(key)}` };
  }
  if (key.startsWith("setting:")) {
    const path = key.slice(8);
    if (excluded(path)) return { error: `excluded setting ${path}` };
    const spec = SETTINGS_ALLOWLIST[path];
    return spec ? { kind: "setting", path, spec } : { error: `setting ${path} is not on the allowlist` };
  }
  return { error: `not a config key: ${JSON.stringify(key)}` };
}

export function readPath(config: unknown, path: string): unknown {
  let v: unknown = config;
  for (const seg of path.split(".")) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

// First string that looks like an absolute path inside a home directory, searched recursively.
export function absoluteHomePath(v: unknown): string | null {
  if (typeof v === "string") return HOME_PATH.test(v) ? v : null;
  if (Array.isArray(v)) { for (const x of v) { const h = absoluteHomePath(x); if (h) return h; } return null; }
  if (v && typeof v === "object") { for (const x of Object.values(v)) { const h = absoluteHomePath(x); if (h) return h; } return null; }
  return null;
}

const optStr = (v: unknown, max = 500) => v === undefined || (typeof v === "string" && v.length <= max);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const UNSAFE = "blocked: unsafe path" as const;
type Check<T> = { ok: true; value: T } | { ok: false; state: typeof UNSAFE; detail: string };

// Only the portable fields, each type-checked; anything with a home path is refused (it would not mean the same thing
// on the other host).
export function pickProfile(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of PROFILE_FIELDS) if (p[f] !== undefined) out[f] = p[f];
  return out;
}
export function portableProfile(p: Record<string, unknown>): Check<Record<string, unknown>> {
  if (!isRecord(p)) return { ok: false, state: UNSAFE, detail: "profile is not an object" };
  const v = pickProfile(p);
  if (typeof v.id !== "string" || !PROFILE_ID.test(v.id)) return { ok: false, state: UNSAFE, detail: "invalid profile id" };
  if (typeof v.name !== "string" || v.name.length > 200 || typeof v.provider !== "string" || !PROFILE_ID.test(v.provider))
    return { ok: false, state: UNSAFE, detail: "profile name or provider invalid" };
  for (const f of ["icon", "color", "model", "modeId", "thinkingOptionId"] as const) if (!optStr(v[f])) return { ok: false, state: UNSAFE, detail: `profile ${f} invalid` };
  if (!optStr(v.notes, MAX_TEXT)) return { ok: false, state: UNSAFE, detail: "profile notes invalid" };
  if (v.featureValues !== undefined && !isRecord(v.featureValues)) return { ok: false, state: UNSAFE, detail: "profile featureValues invalid" };
  const home = absoluteHomePath(v);
  if (home) return { ok: false, state: UNSAFE, detail: `profile contains a home-directory path (${home.slice(0, 80)})` };
  return { ok: true, value: v };
}

// Validates (and narrows to known fields) one allowlisted setting value. undefined means "absent".
export function portableSetting(path: string, value: unknown): Check<unknown> {
  const spec = SETTINGS_ALLOWLIST[path];
  if (!spec || excluded(path)) return { ok: false, state: UNSAFE, detail: `setting ${path} not allowed` };
  const bad = (d: string) => ({ ok: false as const, state: UNSAFE, detail: `${path}: ${d}` });
  switch (spec.type) {
    case "boolean": return typeof value === "boolean" ? { ok: true, value } : bad("expected a boolean");
    case "string": return typeof value === "string" && value.length <= MAX_TEXT ? { ok: true, value } : bad("expected text");
    case "metadataProviders": {
      if (!Array.isArray(value) || value.length > 50) return bad("expected a list");
      const out = [];
      for (const e of value) {
        if (!isRecord(e) || typeof e.provider !== "string" || !PROFILE_ID.test(e.provider) || !optStr(e.model) || !optStr(e.thinkingOptionId)) return bad("invalid entry");
        out.push({ provider: e.provider, ...(e.model !== undefined ? { model: e.model } : {}), ...(e.thinkingOptionId !== undefined ? { thinkingOptionId: e.thinkingOptionId } : {}) });
      }
      return { ok: true, value: out };
    }
    case "terminalProfiles": {
      if (!Array.isArray(value) || value.length > 50) return bad("expected a list");
      const out = [];
      for (const e of value) {
        if (!isRecord(e) || typeof e.id !== "string" || typeof e.name !== "string" || typeof e.command !== "string" || !optStr(e.icon) ||
          (e.args !== undefined && !(Array.isArray(e.args) && e.args.every(a => typeof a === "string")))) return bad("invalid entry");
        out.push({ id: e.id, name: e.name, command: e.command, ...(e.args !== undefined ? { args: e.args } : {}), ...(e.icon !== undefined ? { icon: e.icon } : {}) });
      }
      const home = absoluteHomePath(out);
      return home ? { ok: false, state: UNSAFE, detail: `${path}: contains a home-directory path (${home.slice(0, 80)})` } : { ok: true, value: out };
    }
    case "selection": {
      if (isRecord(value) && value.mode === "all" && Object.keys(value).length === 1) return { ok: true, value: { mode: "all" } };
      if (isRecord(value) && value.mode === "custom" && Object.keys(value).length === 2 && Array.isArray(value.skills) && value.skills.length <= 500 &&
        value.skills.every(s => typeof s === "string" && SKILL_NAME.test(s))) return { ok: true, value: { mode: "custom", skills: [...value.skills] } };
      return bad("expected {mode:\"all\"} or {mode:\"custom\", skills:[names]}");
    }
  }
}

// The value of one item as found in a config, in the portable projection used for digests (undefined: absent).
export function itemValue(config: unknown, key: string): unknown {
  const k = parseConfigKey(key);
  if ("error" in k) throw new Error(k.error);
  if (k.kind === "profile") {
    const list = readPath(config, "agentProfiles");
    const p = Array.isArray(list) ? list.find(x => isRecord(x) && x.id === k.id) : undefined;
    return p ? pickProfile(p as Record<string, unknown>) : undefined;
  }
  return readPath(config, k.path);
}
export const valueDigest = (v: unknown): string | null => (v === undefined ? null : digest(v));

export type ConfigSnapshot = { items: DesiredItem[]; missing: string[]; blocked: { key: string; detail: string }[] };
// Source side: one desired item per enrolled key; an absent profile or setting is a tombstone, an unsafe one is blocked
// (not sent, the destination copy is left alone).
export function desiredConfigItems(config: unknown, enrolled: EnrolledItem[]): ConfigSnapshot {
  const items: DesiredItem[] = [], missing: string[] = [], blocked: { key: string; detail: string }[] = [];
  for (const e of enrolled) {
    const k = parseConfigKey(e.key);
    if ("error" in k) { blocked.push({ key: e.key, detail: k.error }); continue; }
    const raw = itemValue(config, e.key);
    if (raw === undefined) { missing.push(e.key); continue; }
    const v = k.kind === "profile" ? portableProfile(raw as Record<string, unknown>) : portableSetting(k.path, raw);
    if (!v.ok) { blocked.push({ key: e.key, detail: v.detail }); continue; }
    items.push({ key: e.key, category: "config", digest: digest(v.value), payload: v.value });
  }
  return { items, missing, blocked };
}
