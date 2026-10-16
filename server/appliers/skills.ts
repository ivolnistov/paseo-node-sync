// Destination applier for skills. Order per item: validate the payload -> managed-root boundary check ->
// preflight (actual vs baseline) ->
// discovery-link check -> journal intent -> backup -> stage + swap -> links -> read-back -> verified.
// Nothing unmanaged is ever overwritten, and an incoming payload cannot write outside managed/skills/<name>.
import { lstat, mkdir, readlink, realpath, rename, rm, symlink, writeFile, chmod, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { digestBytes } from "../canonical.ts";
import type { BackupStore } from "../backup-store.ts";
import type { Journal, JournalRecord } from "../journal.ts";
import type { NodePaths } from "../paths.ts";
import { buildSkill, denied, linkStaysInside, manifestDigest, SAFE_SEGMENT, SKILL_LIMITS, within, type SkillFile, type SkillPayload } from "../snapshot/skills.ts";
import type { DesiredItem, ItemResult } from "../../shared/protocol.ts";

// Test-only fault points: `at` throws to simulate a crash after a durable step; failInstall makes the final rename fail.
export type ApplyPoint = "backed-up" | "staged" | "swapped-out" | "mutated";
export interface ApplyHooks { at?(point: ApplyPoint): Promise<void>; failInstall?: boolean; failRollback?: boolean }

export interface SkillsApplyContext { paths: NodePaths; backups: BackupStore; journal: Journal;
  discoveryDirs: string[]; baselines: { get(key: string): string | null; set(key: string, d: string | null): Promise<void> };
  owners: { owns(link: string): boolean; record(link: string): Promise<void>; forget(link: string): Promise<void> };
  hooks?: ApplyHooks }
type SetRef = { id: string; incarnation: string; revision: number };

const unsafe = (key: string, detail: string): ItemResult => ({ key, state: "blocked: unsafe path", detail });
const skillName = (key: string) => key.startsWith("skill:") ? key.slice(6) : null;
const exists = (p: string) => lstat(p).then(() => true, () => false);

// The managed tree is <stateRoot>/managed/skills. The state root is the trusted anchor: it is created if needed and
// resolved once, so aliases ABOVE it (macOS /tmp -> /private/tmp, a symlinked PASEO_HOME) are accepted. Below it,
// each existing component must be a real directory whose realpath is exactly anchor + its relative path; a symlink
// or any other redirection is refused before anything is read or written. Missing components are created one at a
// time (never mkdir -p through them) and only when `create` is set, then checked again.
export type ManagedRoot = { ok: true; dir: string; exists: boolean } | { ok: false; detail: string };
export async function managedSkillsRoot(paths: NodePaths, o: { create: boolean }): Promise<ManagedRoot> {
  if (!paths.managedSkills.startsWith(`${paths.root}/`)) return { ok: false, detail: "managed root is not below the state root" };
  if (o.create) await mkdir(paths.root, { recursive: true, mode: 0o700 });
  let anchor: string;
  try { anchor = await realpath(paths.root); } catch { return o.create ? { ok: false, detail: "state root unavailable" } : { ok: true, dir: paths.managedSkills, exists: false }; }
  let lexical = paths.root, canonical = anchor;
  for (const part of paths.managedSkills.slice(paths.root.length + 1).split("/")) {
    lexical = `${lexical}/${part}`; canonical = `${canonical}/${part}`;
    let st = await lstat(lexical).catch(() => null);
    if (!st) {
      if (!o.create) return { ok: true, dir: canonical, exists: false };
      await mkdir(lexical, { mode: 0o700 }).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; });
      st = await lstat(lexical).catch(() => null);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return { ok: false, detail: `managed root redirected: ${lexical} is not a plain directory` };
    if ((await realpath(lexical)) !== canonical) return { ok: false, detail: `managed root redirected: ${lexical} resolves outside the state root` };
  }
  return { ok: true, dir: canonical, exists: true };
}

// Read-back uses the same walker as the source scan, so an unsafe managed tree never matches a digest. It never
// creates anything; a redirected managed root is reported as an unsafe digest, never as a trusted null or digest.
export async function actualSkillDigest(ctx: SkillsApplyContext, name: string): Promise<string | null> {
  if (!SAFE_SEGMENT.test(name)) throw new Error(`invalid skill name: ${name}`);
  const root = await managedSkillsRoot(ctx.paths, { create: false });
  if (!root.ok) return `unsafe:${root.detail}`;
  if (!root.exists || !(await exists(`${root.dir}/${name}`))) return null;
  const built = await buildSkill({ path: root.dir, realpath: root.dir }, name, false);
  return "blocked" in built ? `unsafe:${built.detail}` : built.digest;
}

// Independent of the sender's scanner: every path, link, mode, size and digest is checked here.
export function validatePayload(item: DesiredItem): { ok: true; payload: SkillPayload } | { ok: false; detail: string } {
  const name = skillName(item.key);
  const p = item.payload as SkillPayload | null;
  if (!name || !SAFE_SEGMENT.test(name)) return { ok: false, detail: `invalid skill key ${JSON.stringify(item.key)}` };
  if (!p || typeof p !== "object" || p.name !== name || !Array.isArray(p.files)) return { ok: false, detail: "payload name does not match the item key" };
  if (p.files.length > SKILL_LIMITS.maxFiles) return { ok: false, detail: "too many files" };
  const seen = new Set<string>();
  let total = 0;
  for (const f of p.files as SkillFile[]) {
    const segs = typeof f.rel === "string" ? f.rel.split("/") : [];
    if (segs.length === 0 || segs.length > 32 || !segs.every(s => SAFE_SEGMENT.test(s))) return { ok: false, detail: `unsafe path ${JSON.stringify(f.rel)}` };
    if (seen.has(f.rel)) return { ok: false, detail: `duplicate path ${f.rel}` };
    seen.add(f.rel);
    if (denied(f.rel)) return { ok: false, detail: `${f.rel}: deny-listed name` };
    if (f.mode !== 0o644 && f.mode !== 0o755) return { ok: false, detail: `${f.rel}: unsupported mode` };
    if (f.link !== undefined) {
      if (typeof f.link !== "string" || !linkStaysInside(f.rel, f.link)) return { ok: false, detail: `${f.rel}: link escapes the skill directory` };
      if (f.size !== 0 || f.digest !== digestBytes(Buffer.from(f.link)) || f.dataB64 !== undefined) return { ok: false, detail: `${f.rel}: link entry does not match its digest` };
      continue;
    }
    if (typeof f.dataB64 !== "string") return { ok: false, detail: `${f.rel}: missing data` };
    const data = Buffer.from(f.dataB64, "base64");
    if (data.length !== f.size || data.length > SKILL_LIMITS.maxFileBytes) return { ok: false, detail: `${f.rel}: size mismatch or too large` };
    if (digestBytes(data) !== f.digest) return { ok: false, detail: `${f.rel}: data does not match its digest` };
    total += data.length;
  }
  // A path that is both a file and a directory prefix of another entry would make the tree ambiguous.
  for (const r of seen) if ([...seen].some(o => o.startsWith(`${r}/`))) return { ok: false, detail: `${r}: used as both a file and a directory` };
  if (total > SKILL_LIMITS.maxSkillBytes) return { ok: false, detail: "skill too large" };
  if (manifestDigest(name, p.files) !== item.digest) return { ok: false, detail: "manifest digest does not match the item digest" };
  return { ok: true, payload: p };
}

// A discovery entry is ours only if recorded as owned AND still pointing at our managed directory.
async function linkCheck(ctx: SkillsApplyContext, root: string, name: string): Promise<{ ok: true; missing: string[]; owned: string[] } | { ok: false; detail: string }> {
  const missing: string[] = [], owned: string[] = [];
  for (const d of ctx.discoveryDirs) {
    const path = `${d}/${name}`;
    const st = await lstat(path).catch(() => null);
    if (!st) { missing.push(path); continue; }
    if (st.isSymbolicLink() && ctx.owners.owns(path) && (await readlink(path)) === `${root}/${name}`) { owned.push(path); continue; }
    return { ok: false, detail: `unmanaged collision: ${path}` };
  }
  return { ok: true, missing, owned };
}

async function writeTree(dir: string, payload: SkillPayload) {
  await mkdir(dir, { recursive: true, mode: 0o755 });
  for (const f of payload.files) {
    const target = `${dir}/${f.rel}`;
    if (!within(dir, target)) throw new Error(`refusing to write outside ${dir}: ${f.rel}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    if (f.link !== undefined) await symlink(f.link, target);
    else { await writeFile(target, Buffer.from(f.dataB64!, "base64"), { flag: "wx" }); await chmod(target, f.mode); }
  }
}

async function preflight(ctx: SkillsApplyContext, key: string, name: string) {
  const actual = await actualSkillDigest(ctx, name);
  const baseline = ctx.baselines.get(key);
  return { actual, baseline, drift: actual !== baseline };
}

// opts.acceptDrift: operator chose "take source" for a blocked item. Only the drift comparison is skipped; payload
// validation, the root guard, link collisions, backup and read-back still apply.
export async function applySkill(ctx: SkillsApplyContext, set: SetRef, g: number, item: DesiredItem, opts: { acceptDrift?: boolean } = {}): Promise<ItemResult> {
  const v = validatePayload(item);
  if (!v.ok) return unsafe(item.key, v.detail);
  const name = v.payload.name;
  const root = await managedSkillsRoot(ctx.paths, { create: true });
  if (!root.ok) return unsafe(item.key, root.detail);
  const pre = await preflight(ctx, item.key, name);
  if (pre.drift && !opts.acceptDrift) return { key: item.key, state: "blocked: local change", detail: pre.baseline === null ? "unmanaged copy exists" : "managed copy changed locally",
    desiredDigest: item.digest, ...(pre.actual ? { actualDigest: pre.actual } : {}) };
  const links = await linkCheck(ctx, root.dir, name);
  if (!links.ok) return { key: item.key, state: "blocked: local change", detail: links.detail, desiredDigest: item.digest };
  if (pre.actual === item.digest && links.missing.length === 0 && !pre.drift) return { key: item.key, state: "in-sync", desiredDigest: item.digest, actualDigest: pre.actual };

  const rec = await ctx.journal.open({ registryRevision: set.revision, setId: set.id, incarnation: set.incarnation, generation: g,
    itemKey: item.key, category: "skills", op: "apply", baselineDigest: pre.baseline, desiredDigest: item.digest });
  const target = `${root.dir}/${name}`;
  const backup = await ctx.backups.saveDir({ setId: set.id, itemKey: item.key, generation: g, opId: rec.opId, kind: "skill-dir",
    restorable: "restorable (archived)", digest: pre.actual }, pre.actual === null ? null : target);
  await ctx.journal.advance(rec.opId, "backed-up", { backupId: backup.backupId });
  await ctx.hooks?.at?.("backed-up");

  const staging = `${root.dir}/.staging-${rec.opId}`, trash = `${root.dir}/.trash-${rec.opId}`;
  await writeTree(`${staging}/${name}`, v.payload);
  const stagedBuilt = await buildSkill({ path: staging, realpath: staging }, name, false);
  if ("blocked" in stagedBuilt || stagedBuilt.digest !== item.digest) {
    await rm(staging, { recursive: true, force: true });
    await ctx.journal.note(rec.opId, "failed: staged copy does not match the desired digest; nothing changed");
    return { key: item.key, state: "failed", detail: "staged copy does not match the desired digest; previous state untouched", backupId: backup.backupId, desiredDigest: item.digest };
  }
  await ctx.hooks?.at?.("staged");
  const hadCurrent = pre.actual !== null;
  if (hadCurrent) await rename(target, trash);
  await ctx.hooks?.at?.("swapped-out");
  try {
    if (ctx.hooks?.failInstall) throw new Error("injected install failure");
    await rename(`${staging}/${name}`, target);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    let restore = hadCurrent ? "previous copy rolled back" : "nothing installed";
    if (hadCurrent) {
      try {
        if (ctx.hooks?.failRollback) throw new Error("injected rollback failure");
        await rename(trash, target);
      } catch (re) {
        // The previous copy stays in its trash directory and in the backup; recovery will see an uncertain state.
        restore = `rollback failed (${(re as Error).message}); previous copy kept at ${trash} and in backup ${backup.backupId}`;
      }
    }
    const detail = `install failed (${(e as Error).message}); ${restore}`;
    await ctx.journal.note(rec.opId, `failed: ${detail}`);
    return { key: item.key, state: "failed", detail, backupId: backup.backupId, desiredDigest: item.digest };
  }
  await rm(staging, { recursive: true, force: true });
  if (hadCurrent) await rm(trash, { recursive: true, force: true });
  for (const l of links.missing) {
    await mkdir(dirname(l), { recursive: true });
    await symlink(target, l);
    await ctx.owners.record(l);
  }
  await ctx.journal.advance(rec.opId, "mutated");
  await ctx.hooks?.at?.("mutated");

  const actual = await actualSkillDigest(ctx, name);
  if (actual !== item.digest) {
    await ctx.journal.note(rec.opId, "failed: read-back mismatch");
    return { key: item.key, state: "failed", detail: "read-back does not match the desired digest", backupId: backup.backupId,
      desiredDigest: item.digest, ...(actual ? { actualDigest: actual } : {}) };
  }
  // Baseline first: a crash right after "verified" must not leave a verified copy that looks unmanaged.
  await ctx.baselines.set(item.key, item.digest);
  await ctx.journal.advance(rec.opId, "verified");
  return { key: item.key, state: "in-sync", backupId: backup.backupId, desiredDigest: item.digest, actualDigest: actual };
}

export async function deleteSkill(ctx: SkillsApplyContext, set: SetRef, g: number, key: string): Promise<ItemResult> {
  const name = skillName(key);
  if (!name || !SAFE_SEGMENT.test(name)) return unsafe(key, `invalid skill key ${JSON.stringify(key)}`);
  const baseline = ctx.baselines.get(key);
  if (baseline === null) return { key, state: "unmanaged", detail: "never applied here; nothing deleted" };
  const root = await managedSkillsRoot(ctx.paths, { create: false });
  if (!root.ok) return unsafe(key, root.detail);
  const pre = await preflight(ctx, key, name);
  if (pre.drift) return { key, state: "blocked: local change", detail: "managed copy changed locally", ...(pre.actual ? { actualDigest: pre.actual } : {}) };
  const links = await linkCheck(ctx, root.dir, name);
  if (!links.ok) return { key, state: "blocked: local change", detail: links.detail };

  const rec: JournalRecord = await ctx.journal.open({ registryRevision: set.revision, setId: set.id, incarnation: set.incarnation, generation: g,
    itemKey: key, category: "skills", op: "delete", baselineDigest: baseline, desiredDigest: null });
  const target = `${root.dir}/${name}`;
  const backup = await ctx.backups.saveDir({ setId: set.id, itemKey: key, generation: g, opId: rec.opId, kind: "skill-dir",
    restorable: "restorable (archived)", digest: pre.actual }, target);
  await ctx.journal.advance(rec.opId, "backed-up", { backupId: backup.backupId });
  for (const l of links.owned) { await unlink(l); await ctx.owners.forget(l); }
  await rm(target, { recursive: true, force: true });
  await ctx.journal.advance(rec.opId, "mutated");
  if ((await actualSkillDigest(ctx, name)) !== null) {
    await ctx.journal.note(rec.opId, "failed: managed copy still present after delete");
    return { key, state: "failed", detail: "managed copy still present after delete", backupId: backup.backupId };
  }
  await ctx.baselines.set(key, null);
  await ctx.journal.advance(rec.opId, "verified");
  return { key, state: "deleted (backup kept)", backupId: backup.backupId };
}
