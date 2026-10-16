import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AutonomousSession, SessionHolder, resolveEndpoint, type Connector } from "../server/session.ts";

const api = { marker: "api" } as never;

test("endpoint comes from PASEO_LISTEN, else the daemon's paseo.pid; never a default port", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-sess-`);
  assert.deepEqual(await resolveEndpoint({ PASEO_LISTEN: "127.0.0.1:47001" }, home), { url: "ws://127.0.0.1:47001/ws" });
  assert.deepEqual(await resolveEndpoint({}, home), { state: "endpoint-unknown", detail: "PASEO_LISTEN unset and paseo.pid has no listen address" });
  await writeFile(`${home}/paseo.pid`, JSON.stringify({ pid: 1, listen: "127.0.0.1:47002" }));
  assert.deepEqual(await resolveEndpoint({}, home), { url: "ws://127.0.0.1:47002/ws" });
  assert.equal(((await resolveEndpoint({ PASEO_LISTEN: "/run/paseo.sock" }, home)) as { state: string }).state, "endpoint-unsupported");
  await rm(home, { recursive: true });
});

test("connects at start without any UI, attaches the holder, and closes everything on stop", async () => {
  const holder = new SessionHolder();
  let closed = 0, urls: string[] = [];
  const connector: Connector = { async connect(url) { urls.push(url); return { api, close: async () => { closed++; }, onClose: () => () => {} }; } };
  const s = new AutonomousSession({ holder, connector, env: { PASEO_LISTEN: "127.0.0.1:47001" }, paseoHome: "/nonexistent", backoff: { initialMs: 10, maxMs: 40 } });
  s.start();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(s.status().state, "connected");
  assert.equal(holder.get(), api);
  assert.deepEqual(urls, ["ws://127.0.0.1:47001/ws"]);
  await s.stop();
  assert.equal(closed, 1);
  assert.equal(s.status().state, "stopped");
  assert.equal(holder.get(), null);
});

test("auth failures and unreachable daemons get named states and capped backoff, not a retry storm", async () => {
  let attempts = 0;
  const connector: Connector = { async connect() { attempts++; throw new Error("Daemon rejected connection: password_required"); } };
  const s = new AutonomousSession({ holder: new SessionHolder(), connector, env: { PASEO_LISTEN: "127.0.0.1:47001" }, paseoHome: "/x", backoff: { initialMs: 20, maxMs: 80 } });
  s.start();
  await new Promise(r => setTimeout(r, 250));
  await s.stop();
  assert.equal(s.lastFailure()?.state, "auth-required");
  assert.ok(attempts >= 2 && attempts <= 6, `attempts ${attempts}`);
  let n = 0;
  const down = new AutonomousSession({ holder: new SessionHolder(), connector: { async connect() { n++; throw new Error("connect ECONNREFUSED 127.0.0.1:47001"); } },
    env: {}, paseoHome: "/nonexistent", backoff: { initialMs: 20, maxMs: 80 } });
  down.start();
  await new Promise(r => setTimeout(r, 100));
  await down.stop();
  assert.equal(n, 0, "no endpoint: never connects");
  assert.equal(down.lastFailure()?.state, "endpoint-unknown");
});

test("a dropped connection is retried and re-attached", async () => {
  const holder = new SessionHolder();
  const drops: (() => void)[] = [];
  let connects = 0;
  const connector: Connector = { async connect() { connects++; return { api, close: async () => {}, onClose: cb => { drops.push(cb); return () => {}; } }; } };
  const s = new AutonomousSession({ holder, connector, env: { PASEO_LISTEN: "127.0.0.1:47001" }, paseoHome: "/x", backoff: { initialMs: 10, maxMs: 40 } });
  s.start();
  await new Promise(r => setTimeout(r, 20));
  drops[0]!();
  assert.equal(holder.get(), null);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(connects, 2);
  assert.equal(holder.get(), api);
  await s.stop();
});
