import { readFile, readdir, mkdir, rename, stat } from "node:fs/promises";
import { writeAtomic, withLock } from "./fsatomic.ts";
import { bundleDigest } from "./canonical.ts";
import type { NodePaths } from "./paths.ts";
import { DocStore } from "./store.ts";
import type { DataBundle, GenerationResult, RegistryBundle, RegistryOutcome, RegistryRequestBundle } from "../shared/protocol.ts";

export interface InboxSetMeta { incarnation: string; latest: number; digests: Record<string, string>; appliedThrough: number }

const readJson = <T>(p: string): Promise<T | null> => readFile(p, "utf8").then(t => JSON.parse(t) as T, e => { if (e.code === "ENOENT") return null; throw e; });
const exists = (p: string) => stat(p).then(() => true, () => false);

// A recreated set (new incarnation) starts fresh. Staged bundles and results of the old incarnation are
// moved aside, never deleted, so nothing about the old set is lost.
async function readMeta(paths: NodePaths, setId: string, incarnation: string): Promise<InboxSetMeta> {
  const meta = await readJson<InboxSetMeta>(paths.inboxMeta(setId));
  if (meta && meta.incarnation === incarnation) return meta;
  if (meta) {
    const archive = `${paths.root}/archive/${setId}/${meta.incarnation}`;
    await mkdir(archive, { recursive: true, mode: 0o700 });
    for (const f of (await readdir(paths.inbox(setId))).filter(f => /^\d+\.json$/.test(f)))
      await rename(`${paths.inbox(setId)}/${f}`, `${archive}/inbox-${f}`);
    const results = `${paths.root}/results/${setId}`;
    if (await exists(results)) await rename(results, `${archive}/results`);
  }
  return { incarnation, latest: 0, digests: {}, appliedThrough: 0 };
}

export async function acceptBundle(paths: NodePaths, admittedIncarnation: string | null, b: DataBundle):
  Promise<{ status: "accepted" | "duplicate" } | { error: "stale-incarnation" | "generation-conflict" | "set-not-admitted" | "bad-schema" }> {
  if (admittedIncarnation === null) return { error: "set-not-admitted" };
  if (b.incarnation !== admittedIncarnation) return { error: "stale-incarnation" };
  if (bundleDigest(b) !== b.digest) return { error: "bad-schema" };
  return withLock(`${paths.inbox(b.setId)}/.lock`, async () => {
    const meta = await readMeta(paths, b.setId, b.incarnation);
    if (b.generation <= meta.latest)
      return meta.digests[String(b.generation)] === b.digest ? { status: "duplicate" as const } : { error: "generation-conflict" as const };
    await writeAtomic(`${paths.inbox(b.setId)}/${b.generation}.json`, JSON.stringify(b));
    meta.latest = b.generation;
    meta.digests[String(b.generation)] = b.digest;
    await writeAtomic(paths.inboxMeta(b.setId), JSON.stringify(meta));
    return { status: "accepted" as const };
  });
}

export async function readResult(paths: NodePaths, setId: string, incarnation: string, g: number):
  Promise<{ status: "pending" | "done" | "unknown"; result?: GenerationResult }> {
  const result = await readJson<GenerationResult>(paths.result(setId, g));
  if (result && result.incarnation === incarnation) return { status: "done", result };
  const meta = await readJson<InboxSetMeta>(paths.inboxMeta(setId));
  if (meta && meta.incarnation === incarnation && meta.digests[String(g)]) return { status: "pending" };
  return { status: "unknown" };
}

// Staged generations of the current incarnation that have no durable result yet, oldest first.
export async function pendingGenerations(paths: NodePaths, setId: string): Promise<number[]> {
  const meta = await readJson<InboxSetMeta>(paths.inboxMeta(setId));
  if (!meta) return [];
  const staged = (await readdir(paths.inbox(setId)).catch(() => [] as string[]))
    .filter(f => /^\d+\.json$/.test(f)).map(f => Number(f.slice(0, -5))).sort((a, b) => a - b);
  const out: number[] = [];
  for (const g of staged) if (!(await readResult(paths, setId, meta.incarnation, g)).result) out.push(g);
  return out;
}

export async function writeResult(paths: NodePaths, r: GenerationResult): Promise<void> {
  await writeAtomic(paths.result(r.setId, r.generation), JSON.stringify(r));
  await withLock(`${paths.inbox(r.setId)}/.lock`, async () => {
    const meta = await readJson<InboxSetMeta>(paths.inboxMeta(r.setId));
    if (meta && meta.incarnation === r.incarnation && r.generation > meta.appliedThrough) {
      meta.appliedThrough = r.generation;
      await writeAtomic(paths.inboxMeta(r.setId), JSON.stringify(meta));
    }
  });
}

// Registry snapshots are keyed by revision and requests by requestId; the same key with another digest is a conflict.
// requestId -> the authenticated peer that first staged it and the bundle digest. Written by the receiver (it knows the
// SSH-authenticated --peer; the bundle itself names no sender) and kept after the request is processed, so a retry stays
// a duplicate of its own request and another peer can never take over that requestId or its outcome.
export interface RequestOwner { peer: string; digest: string }
// "owners.json" never matches the staged-file names that drain() reads.
export const requestOwnersPath = (paths: NodePaths) => `${paths.registryInbox}/owners.json`;
export const readRequestOwners = async (paths: NodePaths) => (await readJson<Record<string, RequestOwner>>(requestOwnersPath(paths))) ?? {};

// What the owner already did with a request whose staged file is gone: "done" when an outcome or a processed copy
// proves this very request (requestId and digest, read from content, not trusted from a file name), "untrusted" when a
// processed file under that name does not verify, "none" when nothing shows it was ever drained.
async function drained(paths: NodePaths, b: RegistryRequestBundle, requester: string | null): Promise<"done" | "untrusted" | "none"> {
  const outcome = (await new DocStore<Record<string, RegistryOutcome>>(`${paths.root}/registry-results.json`, {}).read()).value[b.requestId];
  if (outcome) return outcome.requestId === b.requestId && requester !== null && outcome.requester === requester ? "done" : "untrusted";
  const dir = `${paths.registryInbox}/processed`;
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter(x => x.startsWith(`request-${b.requestId}.`))) {
    const copy = await readJson<{ kind?: string; requestId?: string; digest?: string }>(`${dir}/${f}`).catch(() => null);
    if (copy?.kind === "registry-request" && copy.requestId === b.requestId && copy.digest === b.digest) return "done";
    return "untrusted";
  }
  return "none";
}

// test-only: faults.afterOwners throws after the owner reservation is durable and before the staged file is written.
export async function stageRegistry(paths: NodePaths, b: RegistryBundle | RegistryRequestBundle, requester?: string,
  faults?: { afterOwners?(): void }): Promise<{ status: "accepted" | "duplicate" } | { error: "generation-conflict" | "bad-schema" }> {
  if (bundleDigest(b) !== b.digest) return { error: "bad-schema" };
  const file = b.kind === "registry" ? `${paths.registryInbox}/registry-${b.revision}.json` : `${paths.registryInbox}/request-${b.requestId}.json`;
  return withLock(`${paths.registryInbox}/.lock`, async () => {
    if (b.kind === "registry-request") {
      if (!requester) return { error: "bad-schema" as const };
      const owners = await readRequestOwners(paths);
      const own = owners[b.requestId];
      if (own) {
        // Another peer, or another digest, under a reserved requestId: always a conflict. The reservation is immutable.
        if (own.peer !== requester || own.digest !== b.digest) return { error: "generation-conflict" as const };
        // The owner's retry. Still staged: duplicate only if the staged copy really is this request.
        const staged = await readJson<{ digest?: string }>(file);
        if (staged) return staged.digest === own.digest ? { status: "duplicate" as const } : { error: "generation-conflict" as const };
        // Already drained: duplicate, never staged or applied again. Unverifiable evidence: fail closed.
        const d = await drained(paths, b, requester);
        if (d === "done") return { status: "duplicate" as const };
        if (d === "untrusted") return { error: "generation-conflict" as const };
        // Reserved but never staged (interrupted between the two writes): stage it now, under the same reservation.
        await writeAtomic(file, JSON.stringify(b));
        return { status: "accepted" as const };
      }
      // A staged or drained request with no recorded owner predates ownership; nobody can claim it.
      if (await readJson(file) || (await drained(paths, b, null)) !== "none") return { error: "generation-conflict" as const };
      await writeAtomic(requestOwnersPath(paths), JSON.stringify({ ...owners, [b.requestId]: { peer: requester, digest: b.digest } }));
      faults?.afterOwners?.();
    }
    const prior = await readJson<{ digest: string }>(file);
    if (prior) return prior.digest === b.digest ? { status: "duplicate" as const } : { error: "generation-conflict" as const };
    await writeAtomic(file, JSON.stringify(b));
    return { status: "accepted" as const };
  });
}
