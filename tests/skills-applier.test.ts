import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, readdir, symlink, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../server/paths.ts";
import { Journal, classifyRecovery } from "../server/journal.ts";
import { BackupStore } from "../server/backup-store.ts";
import { applySkill, deleteSkill, actualSkillDigest, type SkillsApplyContext } from "../server/appliers/skills.ts";
import { digestBytes } from "../server/canonical.ts";
import { manifestDigest, type SkillFile } from "../server/snapshot/skills.ts";

async function ctx(hooks?: SkillsApplyContext["hooks"]) {
  const home = await mkdtemp(`${tmpdir()}/pns-apply-`);
  const paths = nodePaths(`${home}/.paseo`);
  const baselines = new Map<string, string | null>(); const links = new Set<string>();
  const c: SkillsApplyContext = { paths, backups: new BackupStore(paths), journal: new Journal(paths),
    discoveryDirs: [`${home}/.paseo/skills`, `${home}/.claude/skills`],
    baselines: { get: k => baselines.get(k) ?? null, set: async (k, d) => { baselines.set(k, d); } },
    owners: { owns: l => links.has(l), record: async l => { links.add(l); }, forget: async l => { links.delete(l); } }, ...(hooks ? { hooks } : {}) };
  return { home, c, baselines, links };
}
type F = { rel: string; data?: string; mode?: number; link?: string };
function item(name: string, files: F[], tamper?: (f: SkillFile[]) => void) {
  const full: SkillFile[] = files.map(f => f.link !== undefined
    ? { rel: f.rel, mode: 0o644, size: 0, digest: digestBytes(Buffer.from(f.link)), link: f.link }
    : { rel: f.rel, mode: (f.mode ?? 0o644) as 0o644, size: Buffer.byteLength(f.data ?? ""), digest: digestBytes(Buffer.from(f.data ?? "")),
        dataB64: Buffer.from(f.data ?? "").toString("base64") });
  const d = manifestDigest(name, full);
  tamper?.(full);
  return { key: `skill:${name}`, category: "skills" as const, digest: d, payload: { name, files: full } };
}
const v = (text: string) => item("alpha", [{ rel: "SKILL.md", data: text }]);
const set = { id: "skills-home", incarnation: "incarnation-1", revision: 1 };
const exists = (p: string) => lstat(p).then(() => true, () => false);

test("apply creates the managed copy and owned discovery links; a local edit then blocks the next apply", async () => {
  const { home, c } = await ctx();
  assert.equal((await applySkill(c, set, 1, v("v1"))).state, "in-sync");
  for (const d of c.discoveryDirs) {
    assert.ok((await lstat(`${d}/alpha`)).isSymbolicLink());
    assert.equal(await readlink(`${d}/alpha`), `${c.paths.managedSkills}/alpha`);
  }
  await writeFile(`${c.paths.managedSkills}/alpha/SKILL.md`, "edited on destination");
  const r = await applySkill(c, set, 2, v("v2"));
  assert.equal(r.state, "blocked: local change");
  assert.equal(await readFile(`${c.paths.managedSkills}/alpha/SKILL.md`, "utf8"), "edited on destination");
  await rm(home, { recursive: true });
});

test("unmanaged things are never overwritten: an existing dir in a discovery dir, a foreign link, a retargeted owned link, an unmanaged managed-dir", async () => {
  const a = await ctx();
  await mkdir(`${a.home}/.claude/skills/alpha`, { recursive: true });
  const r1 = await applySkill(a.c, set, 1, v("v1"));
  assert.equal(r1.state, "blocked: local change"); assert.match(r1.detail ?? "", /unmanaged collision: .*\.claude\/skills\/alpha/);
  assert.equal(await exists(`${a.c.paths.managedSkills}/alpha`), false, "nothing written before the collision check");
  const b = await ctx();
  await mkdir(`${b.home}/.paseo/skills`, { recursive: true }); await symlink("/somewhere/else", `${b.home}/.paseo/skills/alpha`);
  assert.equal((await applySkill(b.c, set, 1, v("v1"))).state, "blocked: local change");
  const c = await ctx();
  await applySkill(c.c, set, 1, v("v1"));
  await unlink(`${c.home}/.claude/skills/alpha`); await symlink("/user/choice", `${c.home}/.claude/skills/alpha`);
  const r3 = await applySkill(c.c, set, 2, v("v2"));
  assert.equal(r3.state, "blocked: local change"); assert.match(r3.detail ?? "", /unmanaged collision/);
  assert.equal(await readlink(`${c.home}/.claude/skills/alpha`), "/user/choice");
  const d = await ctx();
  await mkdir(`${d.c.paths.managedSkills}/alpha`, { recursive: true }); await writeFile(`${d.c.paths.managedSkills}/alpha/SKILL.md`, "mine");
  assert.equal((await applySkill(d.c, set, 1, v("v1"))).state, "blocked: local change");
  assert.equal(await readFile(`${d.c.paths.managedSkills}/alpha/SKILL.md`, "utf8"), "mine");
  for (const x of [a, b, c, d]) await rm(x.home, { recursive: true });
});

test("incoming payloads cannot reach outside the managed skill directory", async () => {
  const { home, c } = await ctx();
  const cases: [string, ReturnType<typeof item>][] = [
    ["parent rel", item("alpha", [{ rel: "../escape.txt", data: "x" }])],
    ["absolute rel", item("alpha", [{ rel: "/tmp/escape.txt", data: "x" }])],
    ["parent name", item("..", [{ rel: "SKILL.md", data: "x" }])],
    ["nested name", { ...item("alpha", [{ rel: "SKILL.md", data: "x" }]), payload: { name: "a/b", files: [] } }],
    ["escaping link", item("alpha", [{ rel: "doc", link: "../../../etc/passwd" }])],
    ["absolute link", item("alpha", [{ rel: "doc", link: "/etc/passwd" }])],
    ["deny-listed name", item("alpha", [{ rel: ".env", data: "SECRET=1" }])],
    ["mode", item("alpha", [{ rel: "SKILL.md", data: "x" }], f => { (f[0] as { mode: number }).mode = 0o4755; })],
    ["data vs digest", item("alpha", [{ rel: "SKILL.md", data: "x" }], f => { f[0]!.dataB64 = Buffer.from("other").toString("base64"); })],
    ["manifest digest", { ...item("alpha", [{ rel: "SKILL.md", data: "x" }]), digest: `sha256:${"0".repeat(64)}` }],
    ["key/name mismatch", { ...item("alpha", [{ rel: "SKILL.md", data: "x" }]), key: "skill:beta" }],
  ];
  for (const [label, it] of cases) {
    const r = await applySkill(c, set, 1, it);
    assert.equal(r.state, "blocked: unsafe path", `${label}: ${JSON.stringify(r)}`);
  }
  assert.equal(await exists(`${home}/.paseo/escape.txt`), false);
  assert.equal(await exists(`${home}/.paseo/node-sync/managed/escape.txt`), false);
  assert.deepEqual(await readdir(c.paths.managedSkills).catch(() => []), []);
  assert.deepEqual(await c.journal.unfinished(), [], "rejected payloads open no journal record");
  await rm(home, { recursive: true });
});

test("re-applying the same digest is a no-op; an update keeps a restorable backup of the previous copy; modes and links survive", async () => {
  const { home, c } = await ctx();
  const v1 = item("alpha", [{ rel: "SKILL.md", data: "v1" }, { rel: "bin/run.sh", data: "#!/bin/sh", mode: 0o755 }, { rel: "bin/doc", link: "../SKILL.md" }]);
  assert.equal((await applySkill(c, set, 1, v1)).state, "in-sync");
  assert.equal((await stat(`${c.paths.managedSkills}/alpha/bin/run.sh`)).mode & 0o777, 0o755);
  assert.equal(await readlink(`${c.paths.managedSkills}/alpha/bin/doc`), "../SKILL.md");
  const again = await applySkill(c, set, 2, v1);
  assert.equal(again.state, "in-sync");
  assert.equal((await c.backups.list("skills-home", "skill:alpha")).length, 1, "no backup for a no-op");
  const r = await applySkill(c, set, 3, v("v2"));
  assert.equal(r.state, "in-sync");
  const backup = (await c.backups.list("skills-home", "skill:alpha")).find(b => b.backupId === r.backupId)!;
  assert.equal(backup.digest, v1.digest);
  await c.backups.restoreDir(backup.backupId, `${home}/restored`);
  assert.equal(await readFile(`${home}/restored/SKILL.md`, "utf8"), "v1");
  await rm(home, { recursive: true });
});

test("crash boundaries stay explicit: after backup -> retry; after mutation -> complete; mid-swap -> recovery uncertain", async () => {
  const crashAt = (point: string) => ({ at: async (p: string) => { if (p === point) throw new Error(`crash at ${p}`); } });
  for (const [point, expected] of [["backed-up", "retry"], ["mutated", "complete"], ["swapped-out", "blocked: recovery uncertain"]] as const) {
    const { home, c } = await ctx();
    await applySkill(c, set, 1, v("v1")); // v1 cleanly, then crash while applying v2
    c.hooks = crashAt(point);
    await assert.rejects(applySkill(c, set, 2, v("v2")), new RegExp(`crash at ${point}`));
    const [rec] = await c.journal.unfinished();
    assert.ok(rec, `${point}: unfinished record`);
    const decision = classifyRecovery(rec!, await actualSkillDigest(c, "alpha"), { idempotent: true, hasBuild: false });
    assert.equal(decision, expected, `${point}: ${rec!.phase}`);
    await rm(home, { recursive: true });
  }
});

test("a failed install rolls back to the previous copy; a read-back mismatch is failed, keeps the backup and does not move the baseline", async () => {
  const f = await ctx();
  await applySkill(f.c, set, 1, v("v1"));
  f.c.hooks = { failInstall: true };
  const r = await applySkill(f.c, set, 2, v("v2"));
  assert.equal(r.state, "failed"); assert.match(r.detail ?? "", /rolled back/);
  assert.equal(await readFile(`${f.c.paths.managedSkills}/alpha/SKILL.md`, "utf8"), "v1");
  assert.equal(f.baselines.get("skill:alpha"), v("v1").digest);
  const g = await ctx();
  await applySkill(g.c, set, 1, v("v1"));
  g.c.hooks = { at: async p => { if (p === "mutated") await writeFile(`${g.c.paths.managedSkills}/alpha/SKILL.md`, "raced"); } };
  const m = await applySkill(g.c, set, 2, v("v2"));
  assert.equal(m.state, "failed"); assert.match(m.detail ?? "", /read-back/);
  assert.equal(m.desiredDigest, v("v2").digest); assert.notEqual(m.actualDigest, m.desiredDigest); assert.ok(m.backupId);
  assert.equal(g.baselines.get("skill:alpha"), v("v1").digest, "baseline stays at the last verified state");
  assert.deepEqual((await g.c.journal.unfinished()).map(x => x.phase), ["mutated"], "not marked verified");
  for (const x of [f, g]) await rm(x.home, { recursive: true });
});

test("delete removes only a managed, unchanged copy and its owned links, and keeps a backup", async () => {
  const { home, c } = await ctx();
  await applySkill(c, set, 1, v("v1"));
  await unlink(`${home}/.claude/skills/alpha`); await symlink("/user/choice", `${home}/.claude/skills/alpha`);
  const blocked = await deleteSkill(c, set, 2, "skill:alpha");
  assert.equal(blocked.state, "blocked: local change", "a retargeted owned link blocks deletion");
  await unlink(`${home}/.claude/skills/alpha`); await symlink(`${c.paths.managedSkills}/alpha`, `${home}/.claude/skills/alpha`);
  const r = await deleteSkill(c, set, 3, "skill:alpha");
  assert.equal(r.state, "deleted (backup kept)");
  assert.equal(await exists(`${c.paths.managedSkills}/alpha`), false);
  assert.equal(await exists(`${home}/.paseo/skills/alpha`), false);
  assert.ok((await c.backups.list("skills-home", "skill:alpha")).some(b => b.backupId === r.backupId && b.digest === v("v1").digest));
  assert.equal((await deleteSkill(c, set, 4, "skill:never")).state, "unmanaged");
  await rm(home, { recursive: true });
});
