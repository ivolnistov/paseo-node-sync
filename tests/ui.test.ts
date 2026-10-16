// UI flows against the client entry bundled in Paseo's client format, with a stateful fake daemon behind useRpc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleClientEntry, loadClientBundle, Screen, themes, type RpcCall } from "./ui-harness.ts";

const ENTRY = new URL("../index.client.tsx", import.meta.url).pathname;
const code = await bundleClientEntry(ENTRY);

function fakeDaemon(o: { initResult?: (i: { nodeId: string; role: string }) => unknown; initThrows?: string } = {}) {
  const state = { node: null as null | { nodeId: string; role: "owner" | "follower" }, calls: [] as [string, unknown][],
    sets: [] as { id: string; category: string; source: string; destination: string; items: number; state: string; pendingGeneration: null; lastResultAt: null }[],
    requests: [] as { requestId: string; summary: string; status: "requested" | "applied" | "rejected"; error?: string }[],
    candidates: [{ key: "skill:alpha", label: "alpha", root: "/src", enrolled: false, preview: ["SKILL.md", "bin/run.sh"] },
      { key: "skill:beta", label: "beta", root: "/src", enrolled: false, preview: [], managedBySet: "skills-other" },
      { key: "skill:gamma", label: "gamma", root: "/src", enrolled: false, preview: [], blocked: "escape: link escapes the skill directory" }],
    conflicts: [{ setId: "skills-home", key: "skill:alpha", state: "blocked: local change", detail: "managed copy changed locally",
      desiredDigest: `sha256:${"a".repeat(64)}`, actualDigest: `sha256:${"b".repeat(64)}`, compare: { added: [], removed: ["notes.txt"], changed: ["SKILL.md"] } },
      { setId: "skills-home", key: "skill:beta", state: "failed", detail: "failed: install failed" }] as ({ key: string } & Record<string, unknown>)[],
    history: { generations: [{ setId: "skills-home", side: "destination", generation: 2, status: "applied", items: [{ key: "skill:alpha", state: "in-sync" }] }],
      backups: [{ setId: "skills-home", key: "skill:alpha", backupId: "g2-op1-abcdef", generation: 2, restorable: "restorable (archived)", digest: `sha256:${"c".repeat(64)}`, createdAt: "t" }],
      items: [{ setId: "skills-home", key: "skill:alpha", state: "in-sync", generation: 2 }] },
    peers: [{ peerId: "work", registryRole: "follower", verbs: ["put", "fetch-result"], sets: [] as { setId: string; direction: string }[], admittedAt: "t",
      endpoint: { host: "127.0.0.1", port: 22, user: "lab", keyPath: "/k" }, fingerprint: "SHA256:abc", hostKeyFingerprint: "SHA256:def" }] };
  const call: RpcCall = async (method, input) => {
    state.calls.push([method, input]);
    switch (method) {
      case "node-sync.overview": return { node: state.node, registry: { revision: 0, ownerNodeId: state.node?.role === "owner" ? state.node.nodeId : "" },
        sets: state.sets, peers: 1, replication: [], requests: state.requests, runtime: [],
        session: { state: "connected", since: "t", attempts: 1 }, sessionAttached: true, worker: { lastError: null } };
      case "node-sync.enroll.tree": return { ok: true, setId: "skills-home", category: "skills", roots: [{ path: "/src", realpath: "/src", readable: true }],
        candidates: state.candidates };
      case "node-sync.enroll.set": {
        const i = input as { key: string; enrolled: boolean; root?: string };
        const c = state.candidates.find(x => x.key === i.key)!; c.enrolled = i.enrolled;
        return { status: "applied", revision: 2 };
      }
      case "node-sync.roots.add": return (input as { confirmTrust: boolean }).confirmTrust ? { ok: true, realpath: "/r" }
        : { ok: false, error: "trust-not-confirmed", detail: "confirm that files under this root may be sent" };
      case "node-sync.conflicts.list": return { conflicts: state.conflicts };
      case "node-sync.conflicts.resolve": {
        const i = input as { key: string; choice: string };
        state.conflicts = state.conflicts.filter(c => c.key !== i.key);
        return { key: i.key, state: i.choice === "take-source" ? "in-sync" : "unmanaged" };
      }
      case "node-sync.history.list": return state.history;
      case "node-sync.item.rollback": {
        const i = input as { key: string; backupId: string };
        state.history.items = state.history.items.map(x => x.key === i.key ? { ...x, state: "paused" } : x);
        return { key: i.key, state: "paused", detail: `rolled back to ${i.backupId}; resume to follow the source again` };
      }
      case "node-sync.item.resume": {
        const i = input as { key: string };
        state.history.items = state.history.items.map(x => x.key === i.key ? { ...x, state: "in-sync" } : x);
        return { ok: true };
      }
      case "node-sync.node.init": {
        if (o.initThrows) throw new Error(o.initThrows);
        const i = input as { nodeId: string; role: "owner" | "follower" };
        const r = o.initResult?.(i) ?? { ok: true, node: i };
        if ((r as { ok: boolean }).ok) state.node = i;
        return r;
      }
      case "node-sync.peer.list": return { peers: state.peers };
      case "node-sync.peer.admit": {
        const i = input as { peerId: string; setId: string; direction: string };
        if (i.setId === "") return { ok: false, error: "invalid-set-id" };
        state.peers[0]!.sets.push({ setId: i.setId, direction: i.direction });
        return { ok: true };
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return { state, call };
}
// Always unmounts, also when an assertion fails, so the screen's polling timer can never keep the test alive.
async function withScreen(call: RpcCall, o: { compact?: boolean; theme?: "light" | "dark" }, fn: (s: Screen) => Promise<void>) {
  const { screens } = loadClientBundle(code, call);
  const s = await Screen.render(screens.main!.Component, { theme: themes[o.theme ?? "light"], layout: { compact: o.compact ?? false }, params: {} });
  try { await fn(s); } finally { await s.unmount(); }
}

test("a fresh node shows setup with both fixed roles explained; choosing home initialises it as registry owner", async () => {
  const d = fakeDaemon();
  await withScreen(d.call, {}, async s => {
    assert.ok(s.hasText(/not set up yet/));
    assert.ok(s.hasText(/Choose this on the home Mac/) && s.hasText(/Choose this on the work Mac/));
    await s.press("Set up as home (registry owner)");
    await s.settle(50);
    assert.deepEqual(d.state.calls.find(c => c[0] === "node-sync.node.init")?.[1], { nodeId: "home", role: "owner" });
    assert.ok(s.hasText(/Node: home \(registry owner\)/), s.texts().join(" | "));
    assert.equal(s.hasText(/not set up yet/), false, "setup disappears once initialised");
  });
});

test("choosing work initialises a follower; an initialised node never shows setup", async () => {
  const d = fakeDaemon();
  await withScreen(d.call, {}, async s => {
    await s.press("Set up as work (follower)");
    await s.settle(50);
    assert.ok(s.hasText(/Node: work \(follower\)/));
  });
  await withScreen(d.call, {}, async again => { assert.equal(again.hasText(/not set up yet/), false); });
});

test("setup errors are shown: identity already fixed, and a failed RPC", async () => {
  await withScreen(fakeDaemon({ initResult: () => ({ ok: false, error: "already-initialized" }) }).call, {}, async s => {
    await s.press("Set up as home (registry owner)");
    assert.ok(s.hasText(/already set up with a different identity; it cannot be changed/));
  });
  await withScreen(fakeDaemon({ initThrows: "daemon unreachable" }).call, {}, async s => {
    await s.press("Set up as work (follower)");
    assert.ok(s.hasText(/Setup failed: daemon unreachable/));
  });
});

test("admission can be granted in both directions from the Peer tab, and failures are shown", async () => {
  const d = fakeDaemon();
  d.state.node = { nodeId: "home", role: "owner" };
  await withScreen(d.call, {}, async s => {
  await s.press("Peer tab");
  await s.type("Set id to admit", "skills-home");
  await s.press("Direction outbound");
  await s.press("Admit outbound set");
  assert.deepEqual(d.state.calls.filter(c => c[0] === "node-sync.peer.admit").map(c => c[1]), [{ peerId: "work", setId: "skills-home", direction: "outbound" }]);
  assert.ok(s.hasText(/Admitted skills-home \(outbound\) for work/));
  assert.ok(s.hasText(/skills-home \(outbound\)/), "peer card lists the admission after refresh");
  await s.type("Set id to admit", "skills-work");
  await s.press("Direction inbound");
  await s.press("Admit inbound set");
  assert.ok(s.hasText(/skills-work \(inbound\)/));
  await s.type("Set id to admit", "");
  await s.press("Admit inbound set");
  assert.ok(s.hasText(/Admit failed: invalid-set-id/));
  });
});

test("layout follows compact/wide and colours follow the light/dark theme", async () => {
  for (const theme of ["light", "dark"] as const) for (const compact of [true, false]) {
    await withScreen(fakeDaemon().call, { theme, compact }, async s => {
      const root = s.rootStyle();
      assert.equal(root.backgroundColor, themes[theme].colors.surface0);
      assert.equal(root.padding, compact ? 12 : 20);
      assert.equal(s.styleOf("View", "Node setup").padding, compact ? 10 : 14);
    });
  }
});

const home = (d: ReturnType<typeof fakeDaemon>) => {
  d.state.node = { nodeId: "home", role: "owner" };
  d.state.sets = [{ id: "skills-home", category: "skills", source: "home", destination: "work", items: 0, state: "idle", pendingGeneration: null, lastResultAt: null }];
  return d;
};

test("enroll: the first press shows the files to send, the second enrolls; managed-elsewhere and blocked skills cannot be checked", async () => {
  const d = home(fakeDaemon());
  await withScreen(d.call, {}, async s => {
    await s.press("Enroll tab");
    await s.press("Enroll alpha");
    assert.ok(s.hasText(/Files to send: SKILL\.md, bin\/run\.sh\. Press again to enroll\./));
    assert.equal(d.state.calls.filter(c => c[0] === "node-sync.enroll.set").length, 0, "no enrollment before the preview was seen");
    await s.press("Enroll alpha");
    assert.deepEqual(d.state.calls.find(c => c[0] === "node-sync.enroll.set")?.[1], { setId: "skills-home", key: "skill:alpha", enrolled: true, root: "/src" });
    assert.ok(s.hasText(/alpha: enrolled \(registry r2\)/));
    assert.ok(s.hasText(/managed by skills-other/));
    assert.equal(s.find("Pressable", "Enroll beta").props.disabled, true);
    assert.equal(s.find("Pressable", "Enroll gamma").props.disabled, true);
    assert.ok(s.hasText(/blocked: unsafe path — escape/));
  });
});

test("enroll: adding a root requires trust and shows the refusal", async () => {
  const d = home(fakeDaemon());
  await withScreen(d.call, {}, async s => {
    await s.press("Enroll tab");
    await s.type("Root path", "/home/lab/skills");
    await s.press("Add root");
    assert.ok(s.hasText(/Add root failed: trust-not-confirmed/));
    await s.press("Trust this root");
    await s.press("Add root");
    assert.ok(s.hasText(/Root added \(\/r\)/));
  });
});

test("conflicts: compare shows the file differences; take source and keep destination resolve and refresh", async () => {
  const d = home(fakeDaemon());
  await withScreen(d.call, {}, async s => {
    await s.press("Conflicts tab");
    assert.ok(s.hasText(/blocked: local change — managed copy changed locally/));
    await s.press("Compare skill:alpha");
    assert.ok(s.hasText(/removed notes\.txt; changed SKILL\.md/));
    await s.press("Take source skill:alpha");
    assert.deepEqual(d.state.calls.find(c => c[0] === "node-sync.conflicts.resolve")?.[1], { setId: "skills-home", key: "skill:alpha", choice: "take-source" });
    assert.ok(s.hasText(/skill:alpha: in-sync/));
    await s.press("Keep destination skill:beta");
    assert.ok(s.hasText(/skill:beta: unmanaged/));
    assert.ok(s.hasText(/No conflicts\./));
  });
});

test("history: roll back pauses the item; resume follows the source again", async () => {
  const d = home(fakeDaemon());
  await withScreen(d.call, { compact: true, theme: "dark" }, async s => {
    await s.press("History tab");
    assert.ok(s.hasText(/restorable \(archived\)/));
    await s.press("Roll back skill:alpha to g2-op1-abcdef");
    assert.ok(s.hasText(/Roll back skill:alpha: paused — rolled back to g2-op1-abcdef/));
    await s.press("Resume skill:alpha");
    assert.ok(s.hasText(/skills-home · skill:alpha · in-sync/));
  });
});
