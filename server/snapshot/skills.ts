// Skill roots and per-skill manifests. A root defines discovery scope only (skills are enrolled one by one), and it
// is resolved once to a canonical realpath boundary. Nothing below the boundary is followed blindly.
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { digest, digestBytes } from "../canonical.ts";

export interface SkillRoot { path: string; realpath: string }
export interface SkillFile { rel: string; mode: 0o644 | 0o755; size: number; digest: string; link?: string; dataB64?: string }
export interface SkillPayload { name: string; files: SkillFile[] }
export type SkillScan =
  | { status: "ok"; skills: { name: string; manifestDigest: string; problems: string[] }[] }
  | { status: "unreadable"; reason: string };

export const SKILL_LIMITS = { maxFileBytes: 1_048_576, maxFiles: 500, maxSkillBytes: 8_388_608 };
// A guard, not a guarantee: names are previewed before enrollment (design 6.4).
export const DENY = [/^\.env(\..*)?$/, /(^|\/)secrets(\/|$)/, /\.(pem|key|p12|pfx)$/, /^id_(rsa|ed25519|ecdsa)(\.pub)?$/];
// One path segment; also used for skill names, so a name can never introduce a separator or a parent reference.
export const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._@+-]{1,128}$/;

type Blocked = { blocked: "blocked: unsafe path"; detail: string };
const unsafe = (detail: string): Blocked => ({ blocked: "blocked: unsafe path", detail });

export function denied(rel: string): boolean {
  const base = rel.split("/").at(-1) ?? rel;
  return DENY.some(re => re.test(base) || re.test(rel));
}

// Symlink target check: relative, and resolving inside the skill directory (the link's own dir as the base).
export function linkStaysInside(rel: string, target: string): boolean {
  if (target.startsWith("/") || target.includes("\0")) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
  return resolved !== ".." && !resolved.startsWith("../") && !posix.isAbsolute(resolved);
}

export async function resolveRoot(path: string, recorded?: string): Promise<SkillRoot | { error: "missing" | "retargeted" }> {
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return { error: "missing" };
  } catch { return { error: "missing" }; }
  if (recorded !== undefined && real !== recorded) return { error: "retargeted" };
  return { path, realpath: real };
}

// Lists candidate skills (directories directly under the root). An unreadable root is reported as such and must
// never be treated as "no skills" (that would turn into deletions).
export async function scanRoot(root: SkillRoot): Promise<SkillScan> {
  const again = await resolveRoot(root.path, root.realpath);
  if ("error" in again) return { status: "unreadable", reason: again.error };
  let entries: string[];
  try { entries = (await readdir(root.realpath)).sort(); } catch (e) { return { status: "unreadable", reason: (e as Error).message }; }
  const skills: { name: string; manifestDigest: string; problems: string[] }[] = [];
  for (const name of entries) {
    const st = await lstat(`${root.realpath}/${name}`).catch(() => null);
    // Transient applier directories (.staging-<op>, .trash-<op>) are never candidate skills.
    if (!st?.isDirectory() || !SAFE_SEGMENT.test(name) || /^\.(staging|trash)-/.test(name)) continue;
    const built = await buildSkill(root, name, false);
    skills.push("blocked" in built ? { name, manifestDigest: "", problems: [built.detail] } : { name, manifestDigest: built.digest, problems: [] });
  }
  return { status: "ok", skills };
}

export function manifestDigest(name: string, files: SkillFile[]): string {
  return digest({ name, files: files.map(({ dataB64: _data, ...f }) => f).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)) });
}

// Walks one skill directory with lstat only. Any entry that could escape the boundary or carry secrets blocks the
// whole skill, naming the entry.
export async function buildSkill(root: SkillRoot, name: string, withData: boolean): Promise<{ payload: SkillPayload; digest: string } | Blocked> {
  if (!SAFE_SEGMENT.test(name)) return unsafe(`invalid skill name: ${JSON.stringify(name)}`);
  const base = `${root.realpath}/${name}`;
  const st = await lstat(base).catch(() => null);
  if (!st) return unsafe(`${name}: missing`);
  if (!st.isDirectory()) return unsafe(`${name}: not a directory`);
  const files: SkillFile[] = [];
  let total = 0;
  const walk = async (relDir: string): Promise<Blocked | null> => {
    const abs = relDir ? `${base}/${relDir}` : base;
    for (const entry of (await readdir(abs)).sort()) {
      const rel = relDir ? `${relDir}/${entry}` : entry;
      if (!SAFE_SEGMENT.test(entry)) return unsafe(`${rel}: unsupported file name`);
      if (denied(rel)) return unsafe(`${rel}: deny-listed name`);
      const s = await lstat(`${abs}/${entry}`);
      if (s.isDirectory()) { const r = await walk(rel); if (r) return r; continue; }
      if (s.isSymbolicLink()) {
        const target = await readlink(`${abs}/${entry}`);
        if (target.startsWith("/")) return unsafe(`${rel}: absolute link`);
        if (!linkStaysInside(rel, target)) return unsafe(`${rel}: link escapes the skill directory`);
        files.push({ rel, mode: 0o644, size: 0, digest: digestBytes(Buffer.from(target)), link: target });
      } else if (s.isFile()) {
        if (s.size > SKILL_LIMITS.maxFileBytes) return unsafe(`${rel}: file larger than ${SKILL_LIMITS.maxFileBytes} bytes`);
        total += s.size;
        if (total > SKILL_LIMITS.maxSkillBytes) return unsafe(`${name}: skill larger than ${SKILL_LIMITS.maxSkillBytes} bytes`);
        const data = await readFile(`${abs}/${entry}`);
        files.push({ rel, mode: (s.mode & 0o111) !== 0 ? 0o755 : 0o644, size: data.length, digest: digestBytes(data),
          ...(withData ? { dataB64: data.toString("base64") } : {}) });
      } else return unsafe(`${rel}: socket, FIFO or device`);
      if (files.length > SKILL_LIMITS.maxFiles) return unsafe(`${name}: more than ${SKILL_LIMITS.maxFiles} files`);
    }
    return null;
  };
  const problem = await walk("");
  if (problem) return problem;
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { payload: { name, files }, digest: manifestDigest(name, files) };
}

// True when `child` is `parent` or inside it, after resolution (no string-prefix tricks like /a/b vs /a/bc).
export function within(parent: string, child: string): boolean {
  const p = resolve(parent), c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
