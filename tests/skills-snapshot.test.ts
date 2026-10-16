import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveRoot, scanRoot, buildSkill, SKILL_LIMITS } from "../server/snapshot/skills.ts";

async function fixture() {
  const base = await mkdtemp(`${tmpdir()}/pns-skills-`);
  await mkdir(`${base}/real/alpha`, { recursive: true });
  await writeFile(`${base}/real/alpha/SKILL.md`, "---\nname: alpha\n---\nbody\n");
  await symlink(`${base}/real`, `${base}/link-root`);
  return base;
}
const blockedDetail = async (root: Parameters<typeof buildSkill>[0], name = "alpha") => {
  const r = await buildSkill(root, name, false);
  assert.ok("blocked" in r, `expected blocked, got ${JSON.stringify(r)}`);
  assert.equal(r.blocked, "blocked: unsafe path");
  return r.detail;
};

test("symlinked root resolves once to a canonical boundary", async () => {
  const base = await fixture();
  const root = await resolveRoot(`${base}/link-root`);
  assert.ok("realpath" in root && root.realpath.endsWith("/real"));
  await rm(base, { recursive: true });
});

test("escaping or absolute links, deny-listed names, special files and oversize files block the skill", async () => {
  const base = await fixture();
  const root = await resolveRoot(`${base}/real`); assert.ok("realpath" in root);
  const a = `${base}/real/alpha`;
  await symlink("../../outside", `${a}/escape`);
  assert.match(await blockedDetail(root), /escape: link escapes/);
  await rm(`${a}/escape`);
  await symlink("/etc/passwd", `${a}/abs`);
  assert.match(await blockedDetail(root), /abs: absolute link/);
  await rm(`${a}/abs`);
  await writeFile(`${a}/.env`, "X=1");
  assert.match(await blockedDetail(root), /\.env: deny-listed/);
  await rm(`${a}/.env`);
  await mkdir(`${a}/secrets`); await writeFile(`${a}/secrets/x.txt`, "s");
  assert.match(await blockedDetail(root), /secrets/);
  await rm(`${a}/secrets`, { recursive: true });
  execFileSync("/usr/bin/mkfifo", [`${a}/pipe`]);
  assert.match(await blockedDetail(root), /pipe: socket, FIFO or device/);
  await rm(`${a}/pipe`);
  await writeFile(`${a}/big.bin`, Buffer.alloc(SKILL_LIMITS.maxFileBytes + 1));
  assert.match(await blockedDetail(root), /big\.bin: file larger/);
  await rm(base, { recursive: true });
});

test("manifests record modes and in-boundary links, and the digest does not depend on carrying data", async () => {
  const base = await fixture();
  const root = await resolveRoot(`${base}/real`); assert.ok("realpath" in root);
  const a = `${base}/real/alpha`;
  await mkdir(`${a}/scripts`); await writeFile(`${a}/scripts/run.sh`, "#!/bin/sh\n"); await chmod(`${a}/scripts/run.sh`, 0o755);
  await symlink("../SKILL.md", `${a}/scripts/doc`);
  const lean = await buildSkill(root, "alpha", false), full = await buildSkill(root, "alpha", true);
  assert.ok("payload" in lean && "payload" in full);
  assert.equal(lean.digest, full.digest);
  assert.deepEqual(lean.payload.files.map(f => [f.rel, f.mode, f.link ?? null]),
    [["SKILL.md", 0o644, null], ["scripts/doc", 0o644, "../SKILL.md"], ["scripts/run.sh", 0o755, null]]);
  assert.ok(full.payload.files[0]!.dataB64 && !lean.payload.files[0]!.dataB64);
  assert.match((await blockedDetail(root, "../real")), /invalid skill name/);
  await rm(base, { recursive: true });
});

test("unavailable or retargeted root is unreadable, not empty", async () => {
  const base = await fixture();
  const first = await resolveRoot(`${base}/link-root`); assert.ok("realpath" in first);
  await rename(`${base}/real`, `${base}/moved`);
  assert.deepEqual(await resolveRoot(`${base}/link-root`, first.realpath), { error: "missing" });
  assert.deepEqual(await scanRoot(first), { status: "unreadable", reason: "missing" });
  await mkdir(`${base}/other`); await rm(`${base}/link-root`); await symlink(`${base}/other`, `${base}/link-root`);
  assert.deepEqual(await resolveRoot(`${base}/link-root`, first.realpath), { error: "retargeted" });
  assert.deepEqual(await scanRoot(first), { status: "unreadable", reason: "retargeted" });
  await rm(base, { recursive: true });
});

test("a new sibling skill appears in a scan; problems are reported per skill", async () => {
  const base = await fixture();
  const root = await resolveRoot(`${base}/real`); assert.ok("realpath" in root);
  await mkdir(`${base}/real/beta`); await writeFile(`${base}/real/beta/SKILL.md`, "x");
  await writeFile(`${base}/real/beta/id_ed25519`, "k");
  const scan = await scanRoot(root);
  assert.equal(scan.status, "ok");
  assert.deepEqual(scan.status === "ok" && scan.skills.map(s => [s.name, s.problems.length > 0]), [["alpha", false], ["beta", true]]);
  await rm(base, { recursive: true });
});
