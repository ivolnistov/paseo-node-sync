import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, chmod, stat, readlink, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths } from "../server/paths.ts";
import { BackupStore } from "../server/backup-store.ts";

const meta = (g: number, opId: string) => ({ setId: "skills-home", itemKey: "skill:alpha", generation: g, opId, kind: "skill-dir" as const,
  restorable: "restorable (archived)" as const, digest: `sha256:${String(g).repeat(64)}` });

test("directory backups keep content, modes and links as links, and restore to a new place only", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-backup-`);
  const store = new BackupStore(nodePaths(home));
  const src = `${home}/src`;
  await mkdir(src); await writeFile(`${src}/SKILL.md`, "v1"); await writeFile(`${src}/run.sh`, "#!/bin/sh"); await chmod(`${src}/run.sh`, 0o755);
  await symlink("SKILL.md", `${src}/doc`);
  const b = await store.saveDir(meta(1, "op1"), src);
  const absent = await store.saveDir({ ...meta(2, "op2"), digest: null }, null);
  assert.deepEqual((await store.list("skills-home", "skill:alpha")).map(m => [m.backupId, m.digest === null]), [[b.backupId, false], [absent.backupId, true]]);
  await store.restoreDir(b.backupId, `${home}/restored`);
  assert.equal(await readFile(`${home}/restored/SKILL.md`, "utf8"), "v1");
  assert.equal((await stat(`${home}/restored/run.sh`)).mode & 0o777, 0o755);
  assert.equal(await readlink(`${home}/restored/doc`), "SKILL.md");
  await assert.rejects(store.restoreDir(b.backupId, `${home}/restored`), /exists/);
  await assert.rejects(store.restoreDir(absent.backupId, `${home}/nothing`), /no directory/);
  await rm(home, { recursive: true });
});

test("values round-trip; a backup without its meta (crash before meta) is not listed", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-backup-`);
  const paths = nodePaths(home);
  const store = new BackupStore(paths);
  const v = await store.saveValue({ ...meta(1, "op1"), kind: "config-value" }, { model: "a" });
  assert.deepEqual(await store.readValue(v.backupId), { model: "a" });
  const itemDir = (await readdir(`${paths.backups}/skills-home`))[0]!;
  await mkdir(`${paths.backups}/skills-home/${itemDir}/g9-orphan/payload`, { recursive: true });
  assert.deepEqual((await store.list("skills-home", "skill:alpha")).map(m => m.backupId), [v.backupId]);
  await rm(home, { recursive: true });
});
