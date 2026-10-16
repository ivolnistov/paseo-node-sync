export const ITEM_STATES = [
  "pending", "awaiting-operator", "in-sync", "blocked: local change", "blocked: provider missing",
  "blocked: unsafe path", "blocked: recovery uncertain", "failed", "paused", "unmanaged", "deleted (backup kept)",
] as const;
export type ItemState = typeof ITEM_STATES[number];

export const SET_STATES = ["idle", "syncing", "peer-offline", "peer-identity-changed", "source-unreadable", "not-admitted", "paused"] as const;
export type SetState = typeof SET_STATES[number];

export const JOURNAL_PHASES = ["intent", "backed-up", "mutated", "verified", "reported"] as const;
export type JournalPhase = typeof JOURNAL_PHASES[number];

export type ItemCategory = "skill" | "profile" | "setting" | "plugin";

export function itemKey(category: ItemCategory, id: string): string {
  return `${category}:${id}`;
}
