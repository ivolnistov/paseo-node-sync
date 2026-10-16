// Source side of the transport: one ssh process per request, argv only (no shell), a minimal environment,
// pinned host key, no agent, no user ssh config. The remote side is the fixed forced command (receiver).
import { spawn as nodeSpawn } from "node:child_process";
import { decodeFrame, encodeFrame, type ReceiverRequest, type ReceiverResponse } from "../shared/protocol.ts";

export interface PeerEndpoint { peerId: string; host: string; port: number; user: string; key: string; knownHosts: string }
export interface Transport { call(peer: PeerEndpoint, req: ReceiverRequest, timeoutMs?: number): Promise<ReceiverResponse> }

export type TransportErrorKind = "unreachable" | "host-key" | "timeout" | "bad-frame";
export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  constructor(kind: TransportErrorKind, message: string) { super(message); this.kind = kind; }
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]{2,39})$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const PATH = /^\/[A-Za-z0-9 ._\/+@%:=,~-]*$/;
export const SSH_BIN = "/usr/bin/ssh";
const MAX_PREAMBLE = 4096;

// Same option set as the lab client; the host may be a VPN address. Every field is validated, so nothing can
// be read as an ssh option (e.g. a host starting with "-").
export function sshArgv(p: PeerEndpoint): string[] {
  if (!HOST.test(p.host)) throw new Error(`invalid host: ${JSON.stringify(p.host)}`);
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error(`invalid port: ${p.port}`);
  if (!USER.test(p.user)) throw new Error(`invalid user: ${JSON.stringify(p.user)}`);
  for (const f of [p.key, p.knownHosts]) if (!PATH.test(f)) throw new Error(`invalid path: ${JSON.stringify(f)}`);
  const opts = ["StrictHostKeyChecking=yes", "BatchMode=yes", `UserKnownHostsFile=${p.knownHosts}`, "GlobalKnownHostsFile=/dev/null",
    "IdentitiesOnly=yes", "IdentityAgent=none", "ConnectTimeout=10", "ForwardAgent=no", "ClearAllForwardings=yes", "RequestTTY=no", "LogLevel=ERROR"];
  return ["-F", "/dev/null", "-p", String(p.port), "-i", p.key, ...opts.flatMap(o => ["-o", o]), `${p.user}@${p.host}`, "node-sync"];
}

type SpawnLike = (cmd: string, argv: string[], opts: { stdio: ["pipe", "pipe", "pipe"]; env: Record<string, string> }) =>
  { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; kill(sig?: NodeJS.Signals): boolean;
    on(ev: "close", cb: (code: number | null) => void): unknown; on(ev: "error", cb: (e: Error) => void): unknown };

export function sshTransport(o: { ssh?: string; spawn?: SpawnLike } = {}): Transport {
  const spawn = o.spawn ?? (nodeSpawn as unknown as SpawnLike);
  return {
    call(peer, req, timeoutMs = 30_000) {
      return new Promise<ReceiverResponse>((resolve, reject) => {
        const child = spawn(o.ssh ?? SSH_BIN, sshArgv(peer), { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
        const out: Buffer[] = []; let err = "", done = false;
        const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
        // The timeout kills only this ssh child; nothing else is signalled.
        const timer = setTimeout(() => finish(() => { child.kill("SIGKILL"); reject(new TransportError("timeout", `no response within ${timeoutMs} ms`)); }), timeoutMs);
        child.stdout.on("data", (c: Buffer) => { out.push(c); });
        child.stderr.on("data", (c: Buffer) => { if (err.length < 4096) err += c.toString(); });
        child.on("error", e => finish(() => reject(new TransportError("unreachable", e.message))));
        child.on("close", code => finish(() => {
          if (code === 255) {
            reject(new TransportError(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(err) ? "host-key" : "unreachable", err.trim().slice(-300)));
            return;
          }
          const d = decodeFrame(Buffer.concat(out), { maxPreamble: MAX_PREAMBLE });
          if ("value" in d) resolve(d.value as ReceiverResponse);
          else reject(new TransportError("bad-frame", `exit ${code}; ${"error" in d ? d.error : "incomplete frame"}`));
        }));
        child.stdin.end(Buffer.from(encodeFrame(req)));
      });
    },
  };
}
