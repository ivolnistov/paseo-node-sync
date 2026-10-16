// Durable per-operation journal. Intent is on disk before any backup or mutation starts, and a result counts only
// after read-back ("verified"). Recovery inspects actual state and never rolls forward or back blindly.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { writeAtomic, withLock } from "./fsatomic.ts";
import type { NodePaths } from "./paths.ts";
import type { Category } from "../shared/protocol.ts";
import { JOURNAL_PHASES, type JournalPhase } from "../shared/states.ts";

export interface JournalRecord { opId: string; registryRevision: number; setId: string; incarnation: string;
  generation: number; itemKey: string; category: Category; op: "apply" | "delete" | "install" | "update" | "enable" | "disable" | "remove";
  baselineDigest: string | null; desiredDigest: string | null; backupId: string | null;
  phase: JournalPhase; updatedAt: string; detail?: string }

const UNFINISHED: JournalPhase[] = ["intent", "backed-up", "mutated"];
const SET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OPS = ["apply", "delete", "install", "update", "enable", "disable", "remove"];

// A committed record that cannot be read or validated. Its content is unknown, so recovery cannot judge what was
// mutated: the evidence is kept in journal/.invalid/ and a hold marker stays until the operator clears it after repair.
// setId is set only when the damaged record still names a set; otherwise the hold covers the whole node.
export interface JournalHold { file: string; setId: string | null; reason: string; at: string }

function validRecord(v: unknown): v is JournalRecord {
  const r = v as Partial<JournalRecord> | null;
  return !!r && typeof r === "object" && typeof r.opId === "string" && typeof r.setId === "string" && SET_ID.test(r.setId) &&
    typeof r.itemKey === "string" && typeof r.category === "string" && OPS.includes(r.op as string) && typeof r.updatedAt === "string" &&
    JOURNAL_PHASES.includes(r.phase as JournalPhase) && typeof r.generation === "number";
}

export class Journal {
  #paths: NodePaths;
  #now: () => string;
  constructor(paths: NodePaths, now: () => string = () => new Date().toISOString()) { this.#paths = paths; this.#now = now; }

  async open(r: Omit<JournalRecord, "phase" | "updatedAt" | "opId" | "backupId">): Promise<JournalRecord> {
    const rec: JournalRecord = { ...r, opId: randomBytes(8).toString("hex"), backupId: null, phase: "intent", updatedAt: this.#now() };
    await writeAtomic(this.#paths.journal(rec.opId), JSON.stringify(rec));
    return rec;
  }

  async read(opId: string): Promise<JournalRecord> {
    return JSON.parse(await readFile(this.#paths.journal(opId), "utf8")) as JournalRecord;
  }

  advance(opId: string, phase: JournalPhase, patch: Partial<JournalRecord> = {}): Promise<JournalRecord> {
    return withLock(`${this.#paths.journal(opId)}.lock`, async () => {
      const cur = await this.read(opId);
      if (JOURNAL_PHASES.indexOf(phase) < JOURNAL_PHASES.indexOf(cur.phase)) throw new Error("journal phase regression");
      const next: JournalRecord = { ...cur, ...patch, opId, phase, updatedAt: this.#now() };
      await writeAtomic(this.#paths.journal(opId), JSON.stringify(next));
      return next;
    });
  }

  // Updates the detail of a record without moving its phase (e.g. a failed read-back stays "mutated").
  note(opId: string, detail: string): Promise<JournalRecord> {
    return withLock(`${this.#paths.journal(opId)}.lock`, async () => {
      const next = { ...(await this.read(opId)), detail, updatedAt: this.#now() };
      await writeAtomic(this.#paths.journal(opId), JSON.stringify(next));
      return next;
    });
  }

  // Temp files of writeAtomic (".<name>.tmp") never match the name filter, so an interrupted write is not seen here.
  async unfinished(): Promise<JournalRecord[]> {
    const dir = `${this.#paths.root}/journal`;
    const names = (await readdir(dir).catch(() => [] as string[])).filter(f => /^[a-z0-9-]+\.json$/.test(f));
    const out: JournalRecord[] = [];
    for (const f of names) {
      const text = await readFile(`${dir}/${f}`, "utf8").catch(e => ((e as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(e)));
      if (text === null) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      if (!validRecord(parsed)) { await this.#quarantine(f, parsed); continue; }
      if (UNFINISHED.includes(parsed.phase)) out.push(parsed);
    }
    return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.opId.localeCompare(b.opId));
  }

  async #quarantine(f: string, parsed: unknown) {
    const dir = `${this.#paths.root}/journal`, inv = `${dir}/.invalid`;
    await mkdir(inv, { recursive: true, mode: 0o700 });
    const named = (parsed as { setId?: unknown } | undefined)?.setId;
    const setId = typeof named === "string" && SET_ID.test(named) ? named : null;
    const at = this.#now(), stamp = at.replace(/[^0-9]/g, "");
    const kept = `${f.slice(0, -5)}.${stamp}.json`;
    // The hold marker is written before the record moves: a crash in between leaves both, never neither.
    const hold: JournalHold = { file: kept, setId, reason: parsed === undefined ? "unparseable journal record" : "journal record fails validation", at };
    await writeAtomic(`${inv}/${kept}.hold`, JSON.stringify(hold));
    await rename(`${dir}/${f}`, `${inv}/${kept}`);
  }

  async holds(): Promise<JournalHold[]> {
    const inv = `${this.#paths.root}/journal/.invalid`;
    const out: JournalHold[] = [];
    for (const f of (await readdir(inv).catch(() => [] as string[])).filter(x => x.endsWith(".json.hold")))
      // An unreadable marker still holds, and conservatively for the whole node.
      out.push(await readFile(`${inv}/${f}`, "utf8").then(t => JSON.parse(t) as JournalHold).catch(() =>
        ({ file: f.slice(0, -5), setId: null, reason: "unreadable hold marker", at: "" })));
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  // Deliberate operator repair: removes only the hold marker; the quarantined record stays as evidence.
  async clearHold(file: string): Promise<boolean> {
    if (!/^[a-z0-9-]+\.[0-9]+\.json$/.test(file)) return false;
    const marker = `${this.#paths.root}/journal/.invalid/${file}.hold`;
    const exists = await readFile(marker, "utf8").then(() => true, () => false);
    if (exists) await rm(marker);
    return exists;
  }
}

export type RecoveryDecision = "retry" | "complete" | "blocked: recovery uncertain" | "discard-intent";

// intent: nothing was mutated. Build-bearing plugin ops before "verified" can't be judged by version alone.
// Otherwise: still at baseline -> retry after a fresh preflight; already at desired and idempotent -> complete;
// anything else -> uncertain (the operator decides).
export function classifyRecovery(r: JournalRecord, actualDigest: string | null, opts: { idempotent: boolean; hasBuild: boolean }): RecoveryDecision {
  if (r.phase === "intent") return "discard-intent";
  if (opts.hasBuild && JOURNAL_PHASES.indexOf(r.phase) < JOURNAL_PHASES.indexOf("verified")) return "blocked: recovery uncertain";
  if (actualDigest === r.baselineDigest) return "retry";
  if (actualDigest === r.desiredDigest && opts.idempotent) return "complete";
  return "blocked: recovery uncertain";
}
