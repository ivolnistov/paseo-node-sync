// Change observation for source roots: recursive fs.watch (accelerates) plus a periodic rescan (guarantees). The engine
// compares content digests itself, so a spurious or missed event never changes what is sent.
import { watch, type FSWatcher } from "node:fs";
import type { SkillRoot } from "./snapshot/skills.ts";

export interface Observer { start(): Promise<void>; stop(): void; active(): { watchers: number; timer: boolean } }

// stop() is final and may be called at any time, including while start() or a rescan is still reading the roots: an
// arm that finishes after stop() closes what it opened, and no timer is installed after stop().
export function skillsObserver(roots: () => Promise<SkillRoot[]>, onChange: (rootRealpath: string) => void,
  o: { rescanMs?: number; watch?: typeof watch } = {}): Observer {
  const doWatch = o.watch ?? watch;
  let watchers: FSWatcher[] = [], timer: ReturnType<typeof setInterval> | null = null, stopped = false, armSeq = 0;
  const close = () => { for (const w of watchers) w.close(); watchers = []; };
  const arm = async () => {
    const seq = ++armSeq;
    const rs = await roots();
    if (stopped || seq !== armSeq) return; // stopped meanwhile, or a newer arm owns the watchers
    close();
    for (const r of rs) {
      try {
        const w = doWatch(r.realpath, { recursive: true, persistent: false }, () => { if (!stopped) onChange(r.realpath); });
        w.on("error", () => { if (!stopped) onChange(r.realpath); }); // a vanished root is noticed by the next snapshot as unreadable
        watchers.push(w);
      } catch { onChange(r.realpath); }
    }
  };
  return {
    async start() {
      if (stopped || timer) return;
      await arm();
      if (stopped) return;
      timer = setInterval(() => {
        if (stopped) return;
        void arm().catch(() => {});
        void roots().then(rs => { if (!stopped) rs.forEach(r => onChange(r.realpath)); }, () => {});
      }, o.rescanMs ?? 60_000);
      timer.unref?.();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; close(); },
    active: () => ({ watchers: watchers.length, timer: timer !== null }),
  };
}

// Daemon config observation for source config sets: status.daemon_config_changed through the session's
// observeEvents (accelerates) plus a config.get poll every 10 s (guarantees). Only enrolled keys are compared, so an
// unrelated config change triggers nothing; the engine's own digest comparison stays authoritative. Re-subscribes when
// the session object changes (reconnect, attach); stop() releases everything and is final.
export interface ConfigObserverDeps {
  api: () => { config: { get(): Promise<{ config: unknown }> }; observeEvents?(e: string[]): { subscribe(o: { update(m: unknown): void; error?(e: unknown): void }): () => void; release(): Promise<void> } } | null;
  enrolled: () => Promise<{ setId: string; keys: { key: string; resource: string }[] }[]>;
  digestOf: (config: unknown, keys: { key: string; resource: string }[]) => string;
  onChange: (setId: string) => void;
  pollMs?: number;
}
export function configObserver(d: ConfigObserverDeps): Observer {
  let timer: ReturnType<typeof setInterval> | null = null, stopped = false, current: unknown = null, unsub: (() => void) | null = null, release: (() => Promise<void>) | null = null;
  const last = new Map<string, string>();
  let checking = false;
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const api = d.api();
      if (api !== current) { // session changed: move the subscription to the new one
        unsub?.(); void release?.().catch(() => {}); unsub = null; release = null; current = api;
        if (api?.observeEvents) {
          try {
            const sub = api.observeEvents(["status.daemon_config_changed"]);
            unsub = sub.subscribe({ update: () => { void check(); }, error: () => {} });
            release = () => sub.release();
          } catch { /* poll only */ }
        }
      }
      if (!api) return;
      const config = (await api.config.get()).config;
      if (stopped) return;
      for (const s of await d.enrolled()) {
        const now = d.digestOf(config, s.keys);
        if (last.has(s.setId) && last.get(s.setId) !== now) d.onChange(s.setId);
        last.set(s.setId, now);
      }
    } catch { /* the next poll retries */ } finally { checking = false; }
  };
  return {
    async start() {
      if (stopped || timer) return;
      await check();
      if (stopped) return;
      timer = setInterval(() => { void check(); }, d.pollMs ?? 10_000);
      timer.unref?.();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; unsub?.(); void release?.().catch(() => {}); unsub = null; release = null; },
    active: () => ({ watchers: unsub ? 1 : 0, timer: timer !== null }),
  };
}
