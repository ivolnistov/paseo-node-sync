// Pre-existing redirection of the managed tree (a symlinked managed/ or managed/skills) must be refused before any
// read, journal, backup, staging, deletion or discovery-link change. Legitimate aliases ABOVE the state root are fine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../server/paths.ts";
import { Journal } from "../server/journal.ts";
import { BackupStore } from "../server/backup-store.ts";
import { applySkill, deleteSkill, actualSkillDigest, type SkillsApplyContext } from "../server/appliers/skills.ts";
import { digestBytes } from "../server/canonical.ts";
import { manifestDigest, type SkillFile } from "../server/snapshot/skills.ts";

function v(text: string) {
  const data = Buffer.from(text);
  const files: SkillFile[] = [{ rel: "SKILL.md", mode: 0o644, size: data.length, digest: digestBytes(data), dataB64: data.toString("base64") }];
  return { key: "skill:alpha", category: "skills" as const, digest: manifestDigest("alpha", files), payload: { name: "alpha", files } };
}
const set = { id: "skills-home", incarnation: "incarnation-1", revision: 1 };
const exists = (p: string) => lstat(p).then(() => true, () => false);
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of (await readdir(d).catch(() => [] as string[])).sort()) {
      const st = await lstat(`${d}/${e}`);
      out.push(`${rel}${e}${st.isDirectory() ? "/" : ""}`);
      if (st.isDirectory()) await walk(`${d}/${e}`, `${rel}${e}/`);
    }
  };
  await walk(dir, "");
  return out;
}
async function ctx(paseoHome?: string) {
  const home = await mkdtemp(`${tmpdir()}/pns-bound-`);
  const paths = nodePaths(paseoHome ?? `${home}/.paseo`);
  const baselines = new Map<string, string | null>(); const links = new Set<string>();
  const c: SkillsApplyContext = { paths, backups: new BackupStore(paths), journal: new Journal(paths),
    discoveryDirs: [`${home}/.claude/skills`],
    baselines: { get: k => baselines.get(k) ?? null, set: async (k, d) => { baselines.set(k, d); } },
    owners: { owns: l => links.has(l), record: async l => { links.add(l); }, forget: async l => { links.delete(l); } } };
  return { home, c, baselines };
}
async function assertNoSideEffects(c: SkillsApplyContext, home: string) {
  assert.deepEqual(await c.journal.unfinished(), [], "no journal record");
  assert.equal(await exists(`${c.paths.root}/journal`), false, "no journal directory");
  assert.equal(await exists(c.paths.backups), false, "no backup");
  assert.equal(await exists(`${home}/.claude/skills/alpha`), false, "no discovery link");
}

test("a symlinked managed/skills is refused; the outside directory is untouched", async () => {
  const { home, c } = await ctx();
  const outside = `${home}/outside`;
  await mkdir(outside, { recursive: true }); await writeFile(`${outside}/sentinel`, "keep");
  await mkdir(`${c.paths.root}/managed`, { recursive: true }); await symlink(outside, c.paths.managedSkills);
  const r = await applySkill(c, set, 1, v("v1"));
  assert.equal(r.state, "blocked: unsafe path"); assert.match(r.detail ?? "", /managed root redirected/);
  assert.deepEqual(await tree(outside), ["sentinel"]);
  await assertNoSideEffects(c, home);
  await rm(home, { recursive: true });
});

test("a symlinked managed/ with skills absent is refused without creating skills/ outside", async () => {
  const { home, c } = await ctx();
  const outside = `${home}/outside`;
  await mkdir(outside, { recursive: true });
  await mkdir(c.paths.root, { recursive: true }); await symlink(outside, `${c.paths.root}/managed`);
  const r = await applySkill(c, set, 1, v("v1"));
  assert.equal(r.state, "blocked: unsafe path");
  assert.deepEqual(await tree(outside), [], "nothing created outside, not even skills/");
  await assertNoSideEffects(c, home);
  await rm(home, { recursive: true });
});

test("a symlinked managed/ with skills present is refused; the outside tree is unchanged", async () => {
  const { home, c } = await ctx();
  const outside = `${home}/outside`;
  await mkdir(`${outside}/skills/other`, { recursive: true }); await writeFile(`${outside}/skills/other/SKILL.md`, "x");
  await mkdir(c.paths.root, { recursive: true }); await symlink(outside, `${c.paths.root}/managed`);
  const before = await tree(outside);
  assert.equal((await applySkill(c, set, 1, v("v1"))).state, "blocked: unsafe path");
  assert.deepEqual(await tree(outside), before);
  await assertNoSideEffects(c, home);
  await rm(home, { recursive: true });
});

test("delete with a matching baseline after the managed tree was redirected is refused; links and outside copy stay", async () => {
  const { home, c, baselines } = await ctx();
  assert.equal((await applySkill(c, set, 1, v("v1"))).state, "in-sync");
  const journalBefore = await readdir(`${c.paths.root}/journal`);
  const backupsBefore = await tree(c.paths.backups);
  // Move the real managed tree away and point managed/skills at it: content and baseline still match.
  await rename(c.paths.managedSkills, `${home}/moved-skills`); await symlink(`${home}/moved-skills`, c.paths.managedSkills);
  assert.equal(baselines.get("skill:alpha"), v("v1").digest);
  const r = await deleteSkill(c, set, 2, "skill:alpha");
  assert.equal(r.state, "blocked: unsafe path");
  assert.equal(await readFile(`${home}/moved-skills/alpha/SKILL.md`, "utf8"), "v1");
  assert.ok((await lstat(`${home}/.claude/skills/alpha`)).isSymbolicLink(), "discovery link kept");
  assert.deepEqual(await readdir(`${c.paths.root}/journal`), journalBefore, "no new journal record");
  assert.deepEqual(await tree(c.paths.backups), backupsBefore, "no new backup");
  await rm(home, { recursive: true });
});

test("read-back under a redirect is never a trusted null or digest", async () => {
  const { home, c } = await ctx();
  await mkdir(`${home}/outside/alpha`, { recursive: true }); await writeFile(`${home}/outside/alpha/SKILL.md`, "v1");
  await mkdir(c.paths.root, { recursive: true });
  await mkdir(`${c.paths.root}/managed`); await symlink(`${home}/outside`, c.paths.managedSkills);
  const d = await actualSkillDigest(c, "alpha");
  assert.ok(d !== null && d.startsWith("unsafe:"), String(d));
  assert.notEqual(d, v("v1").digest);
  await rm(home, { recursive: true });
});

test("an alias ABOVE the state root (like macOS /tmp) is a legitimate anchor; missing managed dirs are created", async () => {
  const base = await mkdtemp(`${tmpdir()}/pns-alias-`);
  await mkdir(`${base}/real-home`); await symlink(`${base}/real-home`, `${base}/alias-home`);
  const { home, c } = await ctx(`${base}/alias-home/.paseo`);
  const r = await applySkill(c, set, 1, v("v1"));
  assert.equal(r.state, "in-sync", JSON.stringify(r));
  assert.equal(await readFile(`${base}/real-home/.paseo/node-sync/managed/skills/alpha/SKILL.md`, "utf8"), "v1");
  assert.equal(await actualSkillDigest(c, "alpha"), v("v1").digest);
  for (const p of [home, base]) await rm(p, { recursive: true });
});

test("a failed rollback is reported as such and keeps the previous copy and the backup", async () => {
  const { home, c, baselines } = await ctx();
  await applySkill(c, set, 1, v("v1"));
  c.hooks = { failInstall: true, failRollback: true };
  const r = await applySkill(c, set, 2, v("v2"));
  assert.equal(r.state, "failed");
  assert.match(r.detail ?? "", /rollback failed/); assert.doesNotMatch(r.detail ?? "", /rolled back/);
  const trash = (await readdir(c.paths.managedSkills)).filter(n => n.startsWith(".trash-"));
  assert.equal(trash.length, 1, "previous copy kept in its trash directory");
  assert.equal(await readFile(`${c.paths.managedSkills}/${trash[0]}/SKILL.md`, "utf8"), "v1");
  assert.ok(r.backupId && (await c.backups.list("skills-home", "skill:alpha")).some(b => b.backupId === r.backupId));
  const [rec] = await c.journal.unfinished();
  assert.match(rec?.detail ?? "", /rollback failed/);
  assert.equal(baselines.get("skill:alpha"), v("v1").digest);
  assert.equal(await actualSkillDigest(c, "alpha"), null, "managed copy is missing: recovery will see uncertainty");
  await rm(home, { recursive: true });
});
