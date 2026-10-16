import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import contribute from "../index.server.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";

// No PASEO_LISTEN and no paseo.pid: the session stays "endpoint-unknown", so this test cannot reach any daemon.
test("entry registers RPCs and hooks and cleans them up without a daemon", async () => {
  const home = await mkdtemp(`${tmpdir()}/pns-entry-`);
  const saved = { home: process.env.PASEO_HOME, listen: process.env.PASEO_LISTEN };
  process.env.PASEO_HOME = home; delete process.env.PASEO_LISTEN;
  try {
    const handled: string[] = []; let removed = 0, hooks = 0;
    const server = { handle(c: { name: string }) { handled.push(c.name); },
      on() { hooks++; return () => { removed++; }; }, before() { return () => {}; },
      registerSettings() { throw new Error("not used"); } } as unknown as PluginServerContext;
    const cleanup = contribute(server);
    for (const m of ["node-sync.overview", "node-sync.node.init", "node-sync.peer.list", "node-sync.peer.enroll", "node-sync.peer.admit",
      "node-sync.peer.test", "node-sync.registry.change", "node-sync.attach"]) assert.ok(handled.includes(m), m);
    await cleanup();
    assert.equal(removed, hooks);
  } finally {
    if (saved.home === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = saved.home;
    if (saved.listen !== undefined) process.env.PASEO_LISTEN = saved.listen;
    await rm(home, { recursive: true });
  }
});
