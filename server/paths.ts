import { join } from "node:path";
import { ID } from "../shared/protocol.ts";

export interface NodePaths {
  root: string; node: string; peers: string; registry: string; items: string; sets: string;
  inbox(setId: string): string; inboxMeta(setId: string): string; result(setId: string, g: number): string;
  registryInbox: string; journal(opId: string): string;
  backups: string; managedSkills: string; managedPlugins: string; history: string; workerLock: string; receiverLog: string;
}

// Every id that becomes a path component is validated here, so no caller can traverse out of the root.
function id(v: string): string {
  if (!ID.test(v)) throw new Error(`invalid id: ${JSON.stringify(v)}`);
  return v;
}
function generation(g: number): number {
  if (!Number.isSafeInteger(g) || g < 1) throw new Error(`invalid generation: ${g}`);
  return g;
}

export function nodePathsFromRoot(stateRoot: string): NodePaths {
  if (!stateRoot.startsWith("/")) throw new Error("state root must be absolute");
  const r = stateRoot.replace(/\/+$/, "");
  return {
    root: r, node: `${r}/node.json`, peers: `${r}/peers.json`, registry: `${r}/registry.json`, items: `${r}/items.json`, sets: `${r}/sets.json`,
    inbox: s => `${r}/inbox/${id(s)}`, inboxMeta: s => `${r}/inbox/${id(s)}/meta.json`,
    result: (s, g) => `${r}/results/${id(s)}/${generation(g)}.json`,
    registryInbox: `${r}/inbox-registry`, journal: op => `${r}/journal/${id(op)}.json`,
    backups: `${r}/backups`, managedSkills: `${r}/managed/skills`, managedPlugins: `${r}/managed/plugins`,
    history: `${r}/history`, workerLock: `${r}/worker.lock`, receiverLog: `${r}/log/receiver.log`,
  };
}

export function nodePaths(paseoHome: string): NodePaths {
  return nodePathsFromRoot(join(paseoHome, "node-sync"));
}
