// Plugin lifecycle: observer replacement is serialized, cleanup while setup is pending leaves nothing running, a failed
// start is retried, and peer enrollment is ordered with the engine's jobs. Barriers, not timing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { watch, FSWatcher } from "node:fs";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startNodeSync } from "../server/rpc-handlers.ts";
import { skillsObserver, type Observer } from "../server/observer.ts";
import { nodePaths } from "../server/paths.ts";
import { withLock } from "../server/fsatomic.ts";
import { TransportError, type Transport } from "../server/transport-ssh.ts";

const PUB = (n: string) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n.repeat(43)} pns-${n}`;
const deferred = () => { let resolve!: () => void; const p = new Promise<void>(r => { resolve = r; }); return { p, resolve }; };
const turn = () => new Promise<void>(r => setImmediate(r));

function countingWatch() {
  const state = { open: 0 };
  const fn = ((() => { state.open++; const w = new EventEmitter() as unknown as FSWatcher; let closed = false;
    (w as unknown as { close(): void }).close = () => { if (!closed) { closed = true; state.open--; } }; return w; }) as unknown) as typeof watch;
  return { state, fn };
}

test("observer: stop while start is still reading roots leaves no watcher and no timer", async () => {
  const w = countingWatch(), entered = deferred(), gate = deferred();
  const obs = skillsObserver(async () => { entered.resolve(); await gate.p; return [{ path: "/r", realpath: "/r" }]; }, () => {}, { watch: w.fn, rescanMs: 5 });
  const starting = obs.start();
  await entered.p;
  obs.stop();
  gate.resolve(); await starting;
  assert.deepEqual(obs.active(), { watchers: 0, timer: false });
  assert.equal(w.state.open, 0);
});

async function plugin(opts: { failFirstObserver?: boolean; gateFirstRoots?: boolean } = {}) {
  const home = await mkdtemp(`${tmpdir()}/pns-life-`);
  const paseoHome = `${home}/.paseo`;
  const handlers: Record<string, (i: unknown, ctx: unknown) => Promise<unknown>> = {};
  const server = { handle(c: { name: string }, fn: (i: unknown, ctx: unknown) => Promise<unknown>) { handlers[c.name] = fn; },
    on() { return () => {}; }, before() { return () => {}; }, registerSettings() { throw new Error("not used"); } } as unknown as PluginServerContext;
  const transport: Transport = { async call() { throw new TransportError("unreachable", "test: no peers"); } };
  const w = countingWatch();
  const instances: Observer[] = [];
  const firstRoots = { entered: deferred(), gate: deferred() };
  const failed = deferred(), secondStarted = deferred();
  let rootsCalls = 0;
  const observer: typeof skillsObserver = (roots, onChange) => {
    const n = instances.length + 1;
    const gated = async () => { if (opts.gateFirstRoots && ++rootsCalls === 1) { firstRoots.entered.resolve(); await firstRoots.gate.p; } return roots(); };
    const real = skillsObserver(gated, onChange, { watch: w.fn, rescanMs: 5 });
    const inst: Observer = n === 1 && opts.failFirstObserver
      ? { async start() { failed.resolve(); throw new Error("simulated observer start failure"); }, stop() {}, active: () => ({ watchers: 0, timer: false }) }
      : { async start() { await real.start(); if (n === 2) secondStarted.resolve(); }, stop: () => real.stop(), active: () => real.active() };
    instances.push(inst);
    return inst;
  };
  const cleanup = startNodeSync(server, { paseoHome, home, env: {}, transport, tickMs: 3_600_000, observer });
  const call = (m: string, i: unknown = {}) => handlers[m]!(i, {}) as Promise<Record<string, any>>;
  return { home, paseoHome, call, cleanup, instances, w, firstRoots, failed, secondStarted,
    async dispose() { await cleanup(); await rm(home, { recursive: true, force: true }); } };
}

test("a failed start is shown and retried by the next RPC instead of being latched", async () => {
  const p = await plugin({ failFirstObserver: true });
  try {
    await p.call("node-sync.node.init", { nodeId: "home", role: "owner" });
    await p.failed.p; await turn();
    const ov = await p.call("node-sync.overview");
    assert.match(ov.worker.lastError ?? "", /^start: .*simulated observer start failure/);
    await p.secondStarted.p; // the overview call retried the start
    assert.equal(p.instances.length, 2);
    assert.equal(p.instances[1]!.active().timer, true);
    await p.cleanup();
    assert.ok(p.instances.every(i => !i.active().timer && i.active().watchers === 0));
    assert.equal(p.w.state.open, 0);
  } finally { await p.dispose(); }
});

test("cleanup while an observer is still starting and another restart is queued leaves nothing running", async () => {
  const p = await plugin({ gateFirstRoots: true });
  try {
    const src = `${p.home}/src`; await mkdir(src, { recursive: true });
    await p.call("node-sync.node.init", { nodeId: "home", role: "owner" });
    await p.firstRoots.entered.p; // observer 1 is suspended inside start()
    assert.equal((await p.call("node-sync.registry.change", { op: "create-set", set: { id: "s1", source: "home", destination: "work", category: "skills", items: [] } })).status, "applied");
    const adding = p.call("node-sync.roots.add", { setId: "s1", path: src, confirmTrust: true });
    // A later queued job finishes only after roots.add's job, whose handler then queues the second replacement.
    await p.call("node-sync.peer.admit", { peerId: "nobody", setId: "s1", direction: "outbound" });
    assert.equal(p.instances.length, 1, "the second replacement waits for the first");
    const cleaning = p.cleanup();
    p.firstRoots.gate.resolve();
    await cleaning; await adding;
    assert.equal(p.instances.length, 1, "no observer is created after cleanup");
    assert.ok(p.instances.every(i => !i.active().timer && i.active().watchers === 0));
    assert.equal(p.w.state.open, 0);
    await p.cleanup(); // idempotent
  } finally { await p.dispose(); }
});

test("peer enrollment waits for the engine's queue (worker.lock) like admission", async () => {
  const p = await plugin();
  try {
    const held = deferred(), release = deferred();
    const holder = withLock(nodePaths(p.paseoHome).workerLock, async () => { held.resolve(); await release.p; }, { timeoutMs: 10_000 });
    await held.p;
    const enrolling = p.call("node-sync.peer.enroll", { peerId: "work", hostKey: PUB("W"), publicKey: PUB("w"), registryRole: "follower",
      endpoint: { host: "127.0.0.1", port: 22, user: "lab", keyPath: "/k" } });
    // While the lock is held a queued enrollment can never finish; an unqueued one finishes within the window.
    assert.equal(await Promise.race([enrolling.then(() => "enrolled"), new Promise(r => setTimeout(() => r("waiting"), 500))]), "waiting");
    assert.deepEqual((await p.call("node-sync.peer.list")).peers, [], "not enrolled while an engine job holds the queue");
    release.resolve(); await holder;
    assert.equal((await enrolling).ok, true);
    assert.equal((await p.call("node-sync.peer.list")).peers.length, 1);
  } finally { await p.dispose(); }
});
