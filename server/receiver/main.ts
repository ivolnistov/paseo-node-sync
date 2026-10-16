// SSH forced-command receiver: node main.ts --state-root <abs> --peer <id>
// Reads exactly one frame from stdin and writes exactly one frame to stdout. The connection's original
// command (SSH_ORIGINAL_COMMAND) is untrusted and only its length is logged. Payloads and keys are never logged.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeFrame, encodeFrame, parseRequest, MAX_FRAME_BYTES, ID, type ReceiverResponse } from "../../shared/protocol.ts";
import { nodePathsFromRoot, type NodePaths } from "../paths.ts";
import { handleRequest, nodeHello, reject } from "./handle.ts";

const READ_TIMEOUT_MS = 30_000;

function parseArgs(argv: string[]): { stateRoot: string; peer: string } {
  if (argv.length !== 4 || argv[0] !== "--state-root" || argv[2] !== "--peer") throw new Error("usage: --state-root <abs> --peer <id>");
  const [, stateRoot, , peer] = argv as [string, string, string, string];
  if (!stateRoot.startsWith("/")) throw new Error("state root must be absolute");
  if (!ID.test(peer)) throw new Error("invalid peer id");
  return { stateRoot, peer };
}

function readFrame(): Promise<{ value: unknown } | { error: "bad-frame" | "oversize" }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    const finish = (r: { value: unknown } | { error: "bad-frame" | "oversize" }) => {
      if (done) return;
      done = true; clearTimeout(timer); process.stdin.pause(); process.stdin.removeAllListeners("data"); resolve(r);
    };
    const timer = setTimeout(() => finish({ error: "bad-frame" }), READ_TIMEOUT_MS);
    process.stdin.on("data", (c: Buffer) => {
      chunks.push(c); size += c.length;
      const d = decodeFrame(Buffer.concat(chunks));
      if ("value" in d) finish({ value: d.value });
      else if ("error" in d) finish(d);
      else if (size > MAX_FRAME_BYTES + 64) finish({ error: "oversize" });
    });
    process.stdin.on("end", () => finish({ error: "bad-frame" }));
    process.stdin.on("error", () => finish({ error: "bad-frame" }));
  });
}

async function main() {
  let paths: NodePaths | null = null, peer = "?";
  let response: ReceiverResponse;
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), originalCommandBytes: Buffer.byteLength(process.env.SSH_ORIGINAL_COMMAND ?? "") };
  try {
    const args = parseArgs(process.argv.slice(2));
    paths = nodePathsFromRoot(args.stateRoot); peer = args.peer;
    const hello = await nodeHello(paths);
    const frame = await readFrame();
    if ("error" in frame) response = reject(frame.error, "frame rejected", hello);
    else {
      const req = parseRequest(frame.value);
      if ("error" in req) response = reject(req.error, "request rejected", hello);
      else {
        entry.verb = req.verb;
        if (req.verb === "fetch-result") { entry.setId = req.setId; entry.generation = req.generation; }
        else if (req.bundle.kind === "data") { entry.kind = "data"; entry.setId = req.bundle.setId; entry.generation = req.bundle.generation; }
        else entry.kind = req.bundle.kind;
        response = await handleRequest(paths, peer, req);
      }
    }
  } catch (e) {
    response = reject("internal", "receiver error");
    process.exitCode = 2;
    entry.internal = e instanceof Error ? e.message.slice(0, 200) : "unknown";
  }
  entry.peer = peer;
  entry.outcome = response.ok ? response.status : response.error;
  process.stdout.write(encodeFrame(response));
  if (paths) {
    await mkdir(dirname(paths.receiverLog), { recursive: true, mode: 0o700 }).catch(() => {});
    await appendFile(paths.receiverLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch(() => {});
  }
}

await main();
