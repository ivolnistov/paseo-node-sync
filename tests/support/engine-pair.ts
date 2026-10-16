// Two nodes in temp homes: a = "home" (registry owner, skills source), b = "work" (follower, destination).
// The fake transport runs the REAL receiver logic (handleRequest) against the other node's state root.
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nodePaths, type NodePaths } from "../../server/paths.ts";
import { NodeSyncService } from "../../server/service.ts";
import { Stores } from "../../server/state.ts";
import { Journal } from "../../server/journal.ts";
import { BackupStore } from "../../server/backup-store.ts";
import { Engine } from "../../server/engine.ts";
import { SkillsDriver, UnsupportedDriver, type CategoryDriver } from "../../server/drivers/skills.ts";
import { handleRequest } from "../../server/receiver/handle.ts";
import { pendingGenerations } from "../../server/inbox.ts";
import { TransportError, type Transport } from "../../server/transport-ssh.ts";
import type { JournalPhase } from "../../shared/states.ts";
import type { ItemResult } from "../../shared/protocol.ts";

export const SET = "skills-home";
const PUB = (n: string) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n.repeat(43)} pns-${n}`;

class CrashJournal extends Journal {
  armed: JournalPhase | null = null;
  onCrash: () => void = () => {};
  override async advance(opId: string, phase: JournalPhase, patch = {}) {
    const r = await super.advance(opId, phase, patch);
    if (this.armed === phase) { this.armed = null; this.onCrash(); throw new Error(`simulated crash after ${phase}`); }
    return r;
  }
}

export type CommitCrash = "after-result" | "mid-items" | "before-dest";
// failSet: the driver throws for every snapshot/apply of that set (a set-local fault, for fail-soft checks).
// failActualDigest: the driver's actual-state read throws for matching keys (a recovery-only fault).
export interface PairOptions { dropFirstFetchResponse?: boolean; duplicatePut?: boolean; crashDestinationAfter?: JournalPhase; crashCommit?: CommitCrash; failSet?: string;
  failActualDigest?: (key: string) => boolean }

export async function makeEnginePair(o: PairOptions = {}) {
  const homes = { a: await mkdtemp(`${tmpdir()}/pns-eng-a-`), b: await mkdtemp(`${tmpdir()}/pns-eng-b-`) };
  const paths = { a: nodePaths(`${homes.a}/.paseo`), b: nodePaths(`${homes.b}/.paseo`) };
  // A simulated crash kills the destination "process": the tick is fail-soft per set, so the harness itself stops
  // driving b (crashed) until restartDestination() builds a fresh one from disk.
  let offline = false, dropped = false, t = 1, commitArmed = false, crashed = false;
  const now = () => t;
  const transport = (self: "a" | "b"): Transport => ({ async call(peer, req) {
    if (offline) throw new TransportError("unreachable", "simulated: peer offline");
    const target = peer.peerId === "work" ? paths.b : paths.a;
    const as = self === "a" ? "home" : "work";
    if (o.duplicatePut && req.verb === "put" && req.bundle.kind === "data") await handleRequest(target, as, req);
    const res = await handleRequest(target, as, req);
    if (o.dropFirstFetchResponse && !dropped && req.verb === "fetch-result" && !req.setId.startsWith("_")) {
      dropped = true;
      throw new TransportError("timeout", "simulated: response lost after the destination answered");
    }
    return res;
  } });
  const applies = new Map<string, number>();
  const build = (self: "a" | "b", arm = true) => {
    const p = paths[self], stores = new Stores(p);
    const service = new NodeSyncService({ paths: p, transport: transport(self), stores, clock: now });
    const journal = new CrashJournal(p);
    if (self === "b" && arm && o.crashDestinationAfter) journal.armed = o.crashDestinationAfter;
    journal.onCrash = () => { crashed = true; };
    const backups = new BackupStore(p);
    const home = self === "a" ? homes.a : homes.b;
    const skills = new SkillsDriver({ paths: p, stores, journal, backups, discoveryDirs: [`${home}/.paseo/skills`, `${home}/.claude/skills`],
      revision: async () => (await service.registry.read()).value.revision });
    const broken = (id: string) => { if (id === o.failSet) throw new Error(`simulated fault in set ${id}`); };
    const counted: CategoryDriver = { idempotent: skills.idempotent, hasBuild: k => skills.hasBuild(k), snapshot: s => { broken(s.id); return skills.snapshot(s); },
      apply: (set, g, item, opts) => { broken(set.id); applies.set(item.key, (applies.get(item.key) ?? 0) + 1); return skills.apply(set, g, item, opts); },
      remove: (set, g, k) => skills.remove(set, g, k), release: (set, k) => skills.release(set, k),
      restore: (set, g, k, id) => skills.restore(set, g, k, id),
      actualDigest: k => { if (o.failActualDigest?.(k)) throw new Error(`simulated unreadable actual state of ${k}`); return skills.actualDigest(k); } };
    const crash = (point: CommitCrash) => () => { if (self === "b" && arm && commitArmed && o.crashCommit === point) { commitArmed = false; crashed = true; throw new Error(`simulated crash: ${point}`); } };
    const faults = { afterResult: crash("after-result"), afterItemSave: (n: number) => { if (n === 1) crash("mid-items")(); }, beforeSaveDest: crash("before-dest") };
    const engine = new Engine({ service, stores, transport: transport(self), journal, backups, now, faults,
      drivers: { skills: counted, config: new UnsupportedDriver("config sync is not available yet (Task 6)"), plugins: new UnsupportedDriver("plugin sync is not available yet (Task 7)") } });
    return { paths: p, stores, service, journal, backups, engine, home };
  };
  let a = build("a"); let b = build("b");

  // Identity, peers, admissions, the set, and the source root on a.
  await a.service.init({ nodeId: "home", role: "owner" });
  await b.service.init({ nodeId: "work", role: "follower" });
  const ep = { host: "127.0.0.1", port: 22, user: "lab", keyPath: "/k" };
  await a.service.enroll({ peerId: "work", hostKey: PUB("B"), publicKey: PUB("b"), registryRole: "follower", endpoint: ep });
  await b.service.enroll({ peerId: "home", hostKey: PUB("A"), publicKey: PUB("a"), registryRole: "owner", endpoint: ep });
  await a.service.change({ op: "create-set", set: { id: SET, source: "home", destination: "work", category: "skills", items: [] } });
  await a.service.admit({ peerId: "work", setId: SET, direction: "outbound" });
  await b.service.admit({ peerId: "home", setId: SET, direction: "inbound" });
  const src = `${homes.a}/skills-src`;
  await mkdir(src, { recursive: true });
  const srcReal = await realpath(src);
  await a.stores.roots.update(r => ({ ...r, [SET]: [{ path: src, realpath: srcReal }] }));
  const enrolled = new Set<string>();

  const pair = {
    get a() { return a; }, get b() { return b; }, homes, paths: paths as { a: NodePaths; b: NodePaths },
    offline(v: boolean) { offline = v; },
    armCommitCrash() { commitArmed = true; },
    async tickSource() { t += 1e9; await a.engine.tick(); },
    async tickDestination() { await b.engine.tick(); if (crashed) throw new Error("simulated crash: destination process died"); },
    applyCount: (key: string) => applies.get(key) ?? 0,
    async syncOnce() {
      for (let i = 0; i < 20; i++) {
        t += 1e9;
        await a.engine.tick();
        await b.engine.tick();
        if (crashed) throw new Error("simulated crash: destination process died");
        const pending = (await a.stores.sources.read()).value[SET]?.pending ?? null;
        if (!offline && pending === null && (await pendingGenerations(paths.b, SET)).length === 0) { await a.engine.tick(); return; }
        if (offline) return;
      }
    },
    source: {
      async writeSkill(name: string, text: string) {
        await mkdir(`${src}/${name}`, { recursive: true });
        await writeFile(`${src}/${name}/SKILL.md`, text);
        if (!enrolled.has(name)) {
          enrolled.add(name);
          await a.service.change({ op: "enroll", setId: SET, item: { key: `skill:${name}`, resource: `skill:${srcReal}/${name}` } });
        }
      },
      async deleteSkill(name: string) { await rm(`${src}/${name}`, { recursive: true, force: true }); },
      async hideRoot() { await rename(src, `${src}-hidden`); },
      async unenroll(key: string) { await a.service.change({ op: "unenroll", setId: SET, key }); },
      async setState() { return (await a.stores.sources.read()).value[SET]?.state; },
      async runtime() { return (await a.stores.sources.read()).value[SET]; },
      srcRoot: src,
    },
    destination: {
      managed: (name: string) => `${paths.b.managedSkills}/${name}`,
      async editManaged(name: string, text: string) { await writeFile(`${paths.b.managedSkills}/${name}/SKILL.md`, text); },
      async content(name: string) { return readFile(`${paths.b.managedSkills}/${name}/SKILL.md`, "utf8").catch(() => null); },
      async item(key: string) { return (await b.stores.items.read()).value[SET]?.[key]; },
      async itemState(key: string) { return (await b.stores.items.read()).value[SET]?.[key]?.state; },
      backups: (key: string) => b.backups.list(SET, key),
      rollback: (key: string, id: string): Promise<ItemResult> => b.engine.rollback(SET, key, id),
      resume: (key: string) => b.engine.resume(SET, key),
      resolve: (key: string, c: "keep-destination" | "take-source") => b.engine.resolve(SET, key, c),
    },
    async restartSource() { await a.engine.stop(); a = build("a"); await a.engine.recover(); },
    async restartDestination() { await b.engine.stop(); crashed = false; b = build("b", false); await b.engine.recover(); },
    // A fresh destination engine over the same disk state that has not run anything yet (lifecycle tests).
    async replaceDestination() { await b.engine.stop(); crashed = false; b = build("b", false); },
    async cleanup() { await a.engine.stop(); await b.engine.stop(); for (const h of Object.values(homes)) await rm(h, { recursive: true, force: true }); },
  };
  return pair;
}
