// The plugin's own session with its daemon. Plugin server code only receives a PaseoApi inside RPC handlers and
// hooks, so the worker opens its own loopback DaemonClient at startup (lab probe P4): no UI or agent event needed.
// Handler/hook contexts may also attach their PaseoApi, which is used only while the own session is down.
import { readFile } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";

// Calls that exist only on the plugin's own DaemonClient, not on PaseoApi (a captured handler context has none).
export interface OwnSessionExtras {
  saveSkillsSelection?(selection: { mode: "all" } | { mode: "custom"; skills: string[] }, confirmedRemovals: string[]):
    Promise<{ selection: { mode: "all" } | { mode: "custom"; skills: string[] }; confirmationRequired: { removals: string[] } | null }>;
}

export class SessionHolder {
  #own: PaseoApi | null = null;
  #ownExtras: OwnSessionExtras | null = null;
  #captured: PaseoApi | null = null;
  #listeners = new Set<(p: PaseoApi) => void>();
  setOwn(p: PaseoApi | null, extras: OwnSessionExtras | null = null) { this.#own = p; this.#ownExtras = p ? extras : null; if (p) for (const l of this.#listeners) l(p); }
  extras(): OwnSessionExtras | null { return this.#own ? this.#ownExtras : null; }
  attach(p: PaseoApi) { const first = !this.#captured; this.#captured = p; if (first && !this.#own) for (const l of this.#listeners) l(p); }
  get(): PaseoApi | null { return this.#own ?? this.#captured; }
  onAttach(fn: (p: PaseoApi) => void): () => void { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; }
  clear() { this.#own = null; this.#ownExtras = null; this.#captured = null; }
}

export type SessionState = "starting" | "connected" | "endpoint-unknown" | "endpoint-unsupported" | "auth-required" | "unreachable" | "stopped";
export interface SessionStatus { state: SessionState; detail?: string; since: string; attempts: number }

export interface Connection { api: PaseoApi; extras?: OwnSessionExtras; close(): Promise<void>; onClose(cb: () => void): () => void }
export interface Connector { connect(url: string): Promise<Connection> }

// Endpoint of this plugin's own daemon: PASEO_LISTEN (inherited from the daemon), else the daemon's paseo.pid.
// There is deliberately no default port: guessing could connect to a different daemon.
export async function resolveEndpoint(env: Record<string, string | undefined>, paseoHome: string):
  Promise<{ url: string } | { state: "endpoint-unknown" | "endpoint-unsupported"; detail: string }> {
  let listen = env.PASEO_LISTEN;
  if (!listen) {
    const pid = await readFile(`${paseoHome}/paseo.pid`, "utf8").then(t => JSON.parse(t) as { listen?: unknown }, () => null);
    if (pid && typeof pid.listen === "string") listen = pid.listen;
  }
  if (!listen) return { state: "endpoint-unknown", detail: "PASEO_LISTEN unset and paseo.pid has no listen address" };
  if (/^(unix:\/\/|\/|pipe:)/.test(listen)) return { state: "endpoint-unsupported", detail: "unix socket endpoints are not supported by this version" };
  if (!/^[A-Za-z0-9.\-[\]:]+:\d{1,5}$/.test(listen)) return { state: "endpoint-unsupported", detail: "unrecognised listen address" };
  return { url: `ws://${listen}/ws` };
}

// Password-protected daemons are not supported yet: no credential is read, the state is "auth-required".
function classify(e: unknown): { state: SessionState; detail: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (/password_required|incorrect_password|unauthori[sz]ed|auth/i.test(msg)) return { state: "auth-required", detail: "daemon requires a password; not supported in this version" };
  return { state: "unreachable", detail: msg.replace(/[\r\n]+/g, " ").slice(0, 200) };
}

export interface AutonomousSessionOptions {
  holder: SessionHolder; connector: Connector; env: Record<string, string | undefined>; paseoHome: string;
  backoff?: { initialMs: number; maxMs: number };
}

export class AutonomousSession {
  #o: AutonomousSessionOptions;
  #status: SessionStatus;
  #lastFailure: SessionStatus | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #conn: Connection | null = null;
  #unsubscribe: (() => void) | null = null;
  #stopped = false;
  #delay: number;

  constructor(o: AutonomousSessionOptions) {
    this.#o = o;
    this.#delay = o.backoff?.initialMs ?? 2_000;
    this.#status = { state: "starting", since: new Date().toISOString(), attempts: 0 };
  }
  status(): SessionStatus { return { ...this.#status }; }
  lastFailure(): SessionStatus | null { return this.#lastFailure; }

  start() { this.#schedule(0); }

  #set(state: SessionState, detail?: string) {
    this.#status = { state, ...(detail ? { detail } : {}), since: new Date().toISOString(), attempts: this.#status.attempts };
    if (state !== "connected" && state !== "starting" && state !== "stopped") this.#lastFailure = this.status();
  }
  #schedule(ms: number) {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#attempt(); }, ms);
    this.#timer.unref?.();
  }
  #retry() {
    const max = this.#o.backoff?.maxMs ?? 300_000;
    this.#schedule(this.#delay);
    this.#delay = Math.min(this.#delay * 2, max);
  }
  async #attempt() {
    if (this.#stopped) return;
    const ep = await resolveEndpoint(this.#o.env, this.#o.paseoHome);
    if ("state" in ep) { this.#set(ep.state, ep.detail); this.#retry(); return; }
    this.#status.attempts++;
    try {
      const conn = await this.#o.connector.connect(ep.url);
      if (this.#stopped) { await conn.close().catch(() => {}); return; }
      this.#conn = conn;
      this.#o.holder.setOwn(conn.api, conn.extras ?? null);
      this.#delay = this.#o.backoff?.initialMs ?? 2_000;
      this.#set("connected");
      this.#unsubscribe = conn.onClose(() => {
        if (this.#stopped) return;
        this.#o.holder.setOwn(null);
        this.#conn = null;
        this.#set("unreachable", "connection closed");
        this.#retry();
      });
    } catch (e) {
      const c = classify(e);
      this.#set(c.state, c.detail);
      this.#retry();
    }
  }

  async stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#unsubscribe?.();
    this.#o.holder.clear();
    await this.#conn?.close().catch(() => {});
    this.#conn = null;
    this.#status = { state: "stopped", since: new Date().toISOString(), attempts: this.#status.attempts };
  }
}

// Default connector: the bundled @getpaseo/client (a real runtime dependency of this plugin), loopback only.
export function daemonClientConnector(clientId = "plugin-paseo-node-sync"): Connector {
  return {
    async connect(url) {
      const [{ DaemonClient }, { createPaseoApi }] = await Promise.all([import("@getpaseo/client/internal/daemon-client"), import("@getpaseo/client")]);
      const client = new DaemonClient({ url, clientId, clientType: "cli", appVersion: "0.11.1", connectTimeoutMs: 10_000, reconnect: { enabled: false } });
      await client.connect();
      const api = createPaseoApi(client);
      return {
        api,
        extras: {
          saveSkillsSelection: async (selection, confirmedRemovals) => {
            const r = await client.saveAgentSkillsSelection(selection, confirmedRemovals);
            return { selection: r.selection, confirmationRequired: r.confirmationRequired ?? null };
          },
        },
        close: async () => { await api.dispose().catch(() => {}); await client.close().catch(() => {}); },
        onClose: cb => client.subscribeConnectionStatus((s: { status: string }) => { if (s.status === "disconnected") cb(); }),
      };
    },
  };
}
