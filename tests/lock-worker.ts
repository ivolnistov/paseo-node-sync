// Child process for lock.test.ts: runs one withLock call with test-controlled pauses.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { withLock } from "../server/fsatomic.ts";

const o = JSON.parse(process.argv[2]!) as { lock: string; log: string; name: string; holdMs: number; timeoutMs: number;
  pauseBeforeUnlink?: string; pauseAfterJudged?: string; waitMarker?: string; crashMarker?: string };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const append = (what: string) => appendFileSync(o.log, `${o.name} ${what} ${Date.now()}\n`);
const waitFor = async (p: string) => { while (!existsSync(p)) await sleep(5); };

try {
  await withLock(o.lock, async () => {
    append("enter");
    if (o.crashMarker) { writeFileSync(o.crashMarker, "inside"); await new Promise(() => {}); }
    await sleep(o.holdMs);
    append("exit");
  }, { timeoutMs: o.timeoutMs, hooks: {
    afterStaleJudged: o.pauseAfterJudged ? async () => { if (!existsSync(o.pauseAfterJudged!)) { append("judged"); await waitFor(o.pauseAfterJudged!); } } : undefined,
    beforeReclaimUnlink: o.pauseBeforeUnlink ? async () => { append("paused"); await waitFor(o.pauseBeforeUnlink!); } : undefined,
    onWait: o.waitMarker ? reason => { if (!existsSync(o.waitMarker!)) writeFileSync(o.waitMarker!, reason); } : undefined,
  } });
  process.stdout.write("ok");
} catch (e) { process.stdout.write(`error: ${(e as Error).message}`); }
