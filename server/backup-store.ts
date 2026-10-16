// Backups per item and generation. The payload is written first and meta.json last, so a crash in between leaves an
// unregistered directory that list() ignores, never a backup that claims content it does not have.
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { writeAtomic } from "./fsatomic.ts";
import { safeName } from "./canonical.ts";
import type { NodePaths } from "./paths.ts";

export interface BackupMeta { backupId: string; setId: string; itemKey: string; generation: number; opId: string;
  kind: "skill-dir" | "config-value" | "plugin"; restorable: "restorable (archived)" | "reference only (artifact may be unavailable)";
  digest: string | null; createdAt: string; extra?: Record<string, unknown> }

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class BackupStore {
  #paths: NodePaths;
  constructor(paths: NodePaths) { this.#paths = paths; }

  #itemDir(setId: string, itemKey: string): string {
    if (!ID.test(setId)) throw new Error(`invalid set id: ${setId}`);
    return `${this.#paths.backups}/${setId}/${safeName(itemKey)}`;
  }
  async #create(meta: Omit<BackupMeta, "backupId" | "createdAt">, write: (dir: string) => Promise<void>): Promise<BackupMeta> {
    const backupId = `g${meta.generation}-${meta.opId}-${randomBytes(3).toString("hex")}`;
    const dir = `${this.#itemDir(meta.setId, meta.itemKey)}/${backupId}`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await write(dir);
    const full: BackupMeta = { ...meta, backupId, createdAt: new Date().toISOString() };
    await writeAtomic(`${dir}/meta.json`, JSON.stringify(full));
    return full;
  }

  // sourceDir null records that nothing existed before (a restore then means "absent").
  saveDir(meta: Omit<BackupMeta, "backupId" | "createdAt">, sourceDir: string | null): Promise<BackupMeta> {
    return this.#create(meta, async dir => {
      if (sourceDir) await cp(sourceDir, `${dir}/payload`, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    });
  }

  saveValue(meta: Omit<BackupMeta, "backupId" | "createdAt">, value: unknown): Promise<BackupMeta> {
    return this.#create(meta, dir => writeAtomic(`${dir}/value.json`, JSON.stringify({ value })));
  }

  async list(setId: string, itemKey: string): Promise<BackupMeta[]> {
    const base = this.#itemDir(setId, itemKey);
    const out: BackupMeta[] = [];
    for (const d of await readdir(base).catch(() => [] as string[])) {
      const meta = await readFile(`${base}/${d}/meta.json`, "utf8").then(t => JSON.parse(t) as BackupMeta, () => null);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => a.generation - b.generation || a.createdAt.localeCompare(b.createdAt));
  }

  async #locate(backupId: string): Promise<string> {
    if (!/^g\d+-[a-z0-9]+-[0-9a-f]{6}$/.test(backupId)) throw new Error(`invalid backup id: ${backupId}`);
    for (const set of await readdir(this.#paths.backups).catch(() => [] as string[]))
      for (const item of await readdir(`${this.#paths.backups}/${set}`).catch(() => [] as string[])) {
        const dir = `${this.#paths.backups}/${set}/${item}/${backupId}`;
        if (await stat(`${dir}/meta.json`).then(() => true, () => false)) return dir;
      }
    throw new Error(`unknown backup: ${backupId}`);
  }

  // Restores into a path that must not exist yet: a restore never overwrites whatever is there now.
  async restoreDir(backupId: string, target: string): Promise<void> {
    const dir = await this.#locate(backupId);
    if (!(await stat(`${dir}/payload`).then(s => s.isDirectory(), () => false))) throw new Error(`backup ${backupId} has no directory (absent before)`);
    if (await stat(target).then(() => true, () => false)) throw new Error(`restore target exists: ${target}`);
    await cp(`${dir}/payload`, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
  }

  // Read-only location of a directory backup's payload (null when it recorded "absent before").
  async payloadDir(backupId: string): Promise<string | null> {
    const dir = await this.#locate(backupId);
    return (await stat(`${dir}/payload`).then(s => s.isDirectory(), () => false)) ? `${dir}/payload` : null;
  }

  async readValue(backupId: string): Promise<unknown> {
    return (JSON.parse(await readFile(`${await this.#locate(backupId)}/value.json`, "utf8")) as { value: unknown }).value;
  }
}
