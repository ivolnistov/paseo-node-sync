// Wires the node service, the engine, the observer, the plugin's own daemon session and the RPC surface.
import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { nodePaths } from "./paths.ts";
import { NodeSyncService } from "./service.ts";
import { Stores } from "./state.ts";
import { Journal } from "./journal.ts";
import { BackupStore } from "./backup-store.ts";
import { Engine } from "./engine.ts";
import { SkillsDriver, UnsupportedDriver } from "./drivers/skills.ts";
import { configObserver, skillsObserver, type Observer } from "./observer.ts";
import { configDriver, sessionConfigPort } from "./appliers/config.ts";
import { desiredConfigItems } from "./snapshot/config.ts";
import { digest } from "./canonical.ts";
import { itemBaselines } from "./state.ts";
import { Views } from "./views.ts";
import { AutonomousSession, SessionHolder, daemonClientConnector, type Connector } from "./session.ts";
import { sshTransport, type Transport } from "./transport-ssh.ts";
import { attachRpc, conflictsListRpc, conflictsResolveRpc, enrollSetRpc, enrollTreeRpc, historyListRpc, holdClearRpc, itemResumeRpc, itemRollbackRpc,
  nodeInitRpc, overviewRpc, peerAdmitRpc, peerEnrollRpc, peerListRpc, peerTestRpc, registryChangeRpc, rootsAddRpc, setPauseRpc, setResumeRpc } from "../shared/rpc.ts";
import type { RegistryChange } from "../shared/protocol.ts";

export interface StartOptions { paseoHome?: string; home?: string; env?: Record<string, string | undefined>; transport?: Transport; connector?: Connector; tickMs?: number;
  observer?: typeof skillsObserver }

export function startNodeSync(server: PluginServerContext, o: StartOptions = {}): () => Promise<void> {
  const env = o.env ?? process.env;
  const paseoHome = o.paseoHome ?? env.PASEO_HOME ?? `${homedir()}/.paseo`;
  const home = o.home ?? env.HOME ?? homedir();
  const paths = nodePaths(paseoHome);
  const transport = o.transport ?? sshTransport();
  const stores = new Stores(paths);
  const service = new NodeSyncService({ paths, transport, stores });
  const journal = new Journal(paths), backups = new BackupStore(paths);
  const skills = new SkillsDriver({ paths, stores, journal, backups, discoveryDirs: [`${paseoHome}/skills`, `${home}/.claude/skills`],
    revision: async () => (await service.registry.read()).value.revision });
  const holder = new SessionHolder();
  // Lab-only C6 documentation probe: honoured only for a lab home under /tmp/pns-.
  const labDir = env.PNS_LAB_C6_DIR;
  const config = configDriver({ port: () => sessionConfigPort(holder), journal, backups, baselines: itemBaselines(stores),
    revision: async () => (await service.registry.read()).value.revision,
    labPause: labDir && paseoHome.startsWith("/tmp/pns-") && labDir.startsWith("/tmp/pns-") ? { dir: labDir } : null });
  // selectionPatchable: the dedicated saveAgentSkillsSelection route exists (P5); without the plugin's own session the
  // driver reports pending, never "unsupported".
  const engine = new Engine({ service, stores, transport, journal, backups, tickMs: o.tickMs ?? 5_000,
    drivers: { skills, config, plugins: new UnsupportedDriver("plugin sync is not available yet (Task 7)") },
    facts: () => ({ pluginRemovalProof: false, selectionPatchable: true, pluginLsShape: false, sessionAttached: holder.get() !== null }) });
  const configObs = configObserver({
    api: () => holder.get(),
    enrolled: async () => {
      const node = await service.node();
      return (await service.registry.read()).value.sets.filter(s => s.category === "config" && s.source === node?.nodeId).map(s => ({ setId: s.id, keys: s.items }));
    },
    digestOf: (c, keys) => digest(desiredConfigItems(c, keys)),
    onChange: setId => engine.notifyChanged(setId),
  });
  const views = new Views(service, stores, backups, () => sessionConfigPort(holder));
  // The connection starts independently of node.init; the engine (all data processing) waits for node.init.
  const session = new AutonomousSession({ holder, connector: o.connector ?? daemonClientConnector(), env, paseoHome });
  session.start();
  let stopped = false, engineStarted: Promise<void> | null = null, observer: Observer | null = null, observerChain: Promise<void> = Promise.resolve();
  const makeObserver = o.observer ?? skillsObserver;

  const rootsBySet = async () => Object.entries((await stores.roots.read()).value);
  // Replacements are serialized: each waits for the previous one, so no observer is left running unreachable. The new
  // observer is published before its start() awaits, so a stop during setup reaches it (and its start installs nothing).
  const restartObserver = (): Promise<void> => {
    const next = observerChain.then(async () => {
      if (stopped) return;
      observer?.stop();
      const created = makeObserver(async () => (await rootsBySet()).flatMap(([, rs]) => rs), real => {
        void rootsBySet().then(all => { for (const [setId, rs] of all) if (rs.some(r => r.realpath === real)) engine.notifyChanged(setId); });
      });
      observer = created;
      await created.start();
    });
    observerChain = next.catch(() => {});
    return next;
  };
  // A failed start is recorded and forgotten, so the next RPC (node.init or overview) tries again.
  const ensureEngine = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    engineStarted ??= (async () => {
      if (!(await service.node())) { engineStarted = null; return; }
      await engine.start();
      await restartObserver();
      await configObs.start();
    })().catch(e => { engineStarted = null; engine.lastError = { at: new Date().toISOString(), message: `start: ${String(e).slice(0, 290)}` }; });
    return engineStarted;
  };
  void ensureEngine();
  // An optional fallback: a handler/hook context may hand over its PaseoApi. Reported truthfully.
  const attach = (ctx: { paseo?: PaseoApi }) => { if (ctx.paseo) { holder.attach(ctx.paseo); return true; } return false; };
  const kick = () => { void engine.tick().catch(() => {}); };

  server.handle(overviewRpc, async (_i, ctx) => {
    attach(ctx);
    void ensureEngine();
    const holds = (await engine.holds()).slice(0, 20).map(h => ({ file: h.file, scope: h.scope, ...(h.setId ? { setId: h.setId } : {}), reason: h.reason, at: h.at }));
    return { ...(await service.overview()), runtime: await views.runtime(), session: session.status(), sessionAttached: holder.get() !== null,
      worker: { lastError: engine.lastError?.message ?? null, recoveryPending: engine.recoveryPending, holds } };
  });
  server.handle(nodeInitRpc, async (i, ctx) => { attach(ctx); const r = await service.init(i); if (r.ok) void ensureEngine(); return r; });
  server.handle(peerListRpc, async (_i, ctx) => { attach(ctx); return { peers: await service.listPeers() }; });
  // Every peer mutation (bindings, known_hosts) is ordered with the engine's jobs.
  server.handle(peerEnrollRpc, async (i, ctx) => { attach(ctx); const r = await engine.enqueue(() => service.enroll(i)); kick(); return r; });
  server.handle(peerAdmitRpc, async (i, ctx) => { attach(ctx); const r = await engine.enqueue(() => service.admit(i)); kick(); return r; });
  server.handle(peerTestRpc, async (i, ctx) => { attach(ctx); return service.testPeer(i.peerId); });
  server.handle(registryChangeRpc, async (i, ctx) => { attach(ctx); const r = await engine.enqueue(() => service.change(i as RegistryChange)); kick(); return r; });
  server.handle(attachRpc, async (_i, ctx) => ({ attached: attach(ctx) }));
  server.handle(rootsAddRpc, async i => { const r = await engine.enqueue(() => views.addRoot(i.setId, i.path, i.confirmTrust)); if (r.ok) await restartObserver(); return r; });
  server.handle(enrollTreeRpc, async i => views.enrollTree(i.setId));
  server.handle(enrollSetRpc, async i => { const r = await engine.enqueue(() => views.enroll(i.setId, i.key, i.enrolled, i.root, { ...(i.confirmAdvanced !== undefined ? { confirmAdvanced: i.confirmAdvanced } : {}), ...(i.previewDigest !== undefined ? { previewDigest: i.previewDigest } : {}) })); kick(); return r; });
  server.handle(conflictsListRpc, async () => views.conflicts());
  server.handle(conflictsResolveRpc, async i => engine.resolve(i.setId, i.key, i.choice));
  server.handle(historyListRpc, async i => views.history(i.setId));
  server.handle(itemRollbackRpc, async i => engine.rollback(i.setId, i.key, i.backupId));
  server.handle(itemResumeRpc, async i => { await engine.resume(i.setId, i.key); return { ok: true as const }; });
  server.handle(setPauseRpc, async i => { await engine.setPaused(i.setId, true); return { ok: true as const }; });
  server.handle(setResumeRpc, async i => { await engine.setPaused(i.setId, false); kick(); return { ok: true as const }; });
  server.handle(holdClearRpc, async i => ((await engine.clearHold(i.file)) ? { ok: true as const } : { ok: false as const, error: "unknown-hold" }));

  const hooks = (["agent.created", "agent.turn_started", "workspace.created"] as const).map(name => server.on(name, (_e, ctx) => { attach(ctx); }));

  // Idempotent. When it returns, no observer watcher or timer, engine timer, tick or transport call of this plugin remains.
  return async () => {
    stopped = true;
    for (const remove of hooks) remove();
    observer?.stop();
    configObs.stop();
    await observerChain;
    observer?.stop();
    await engine.stop();
    await session.stop();
  };
}
