import { readFile } from "node:fs/promises";
import { writeAtomic, withLock } from "./fsatomic.ts";

export type WriteResult = { status: "saved"; revision: number } | { status: "conflict"; revision: number };

// The sync plugin's own revisioned documents. Server-side PluginSettings is read-only, so registry and
// bindings live here: {revision, value} files, compare-and-set under a lock file.
export class DocStore<T> {
  readonly path: string;
  readonly empty: T;
  constructor(path: string, empty: T) { this.path = path; this.empty = empty; }

  async read(): Promise<{ revision: number; value: T }> {
    const text = await readFile(this.path, "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (text === null) return { revision: 0, value: structuredClone(this.empty) };
    const doc = JSON.parse(text) as { revision: number; value: T };
    if (!Number.isSafeInteger(doc.revision) || !("value" in doc)) throw new Error(`corrupt document: ${this.path}`);
    return doc;
  }

  write(expected: number, value: T): Promise<WriteResult> {
    return withLock(`${this.path}.lock`, async () => {
      const current = await this.read();
      if (current.revision !== expected) return { status: "conflict", revision: current.revision };
      const revision = expected + 1;
      await writeAtomic(this.path, JSON.stringify({ revision, value }));
      return { status: "saved", revision };
    });
  }

  // Read-modify-write entirely under the lock, so concurrent updaters serialize instead of retrying.
  update(fn: (v: T) => T | Promise<T>): Promise<{ revision: number; value: T }> {
    return withLock(`${this.path}.lock`, async () => {
      const current = await this.read();
      const value = await fn(structuredClone(current.value));
      const revision = current.revision + 1;
      await writeAtomic(this.path, JSON.stringify({ revision, value }));
      return { revision, value };
    });
  }
}
