// Whether an item operation may run automatically on this node. Capability gaps, never concurrency gates.
import { PROTOCOL_VERSION, CAPABILITIES, type Category, type DataBundle, type NodeHello } from "../shared/protocol.ts";
import type { JournalRecord } from "./journal.ts";

export interface CapabilityVerdict { automatic: boolean; reason?: string }
export interface CapabilityFacts { pluginRemovalProof: boolean; selectionPatchable: boolean; pluginLsShape: boolean; sessionAttached: boolean }

export function checkBundle(local: NodeHello | null, b: DataBundle): { ok: true } | { ok: false; error: "protocol-unsupported" } {
  const categoryVersion = (local?.capabilities ?? CAPABILITIES)[b.items[0]?.category ?? "skills"] ?? 0;
  return b.protocol === PROTOCOL_VERSION && b.capability <= categoryVersion ? { ok: true } : { ok: false, error: "protocol-unsupported" };
}

export function checkItem(category: Category, op: JournalRecord["op"], facts: CapabilityFacts, key = ""): CapabilityVerdict {
  if (category === "plugins") {
    if (!facts.pluginLsShape) return { automatic: false, reason: "plugin list format not recognised on this Paseo version" };
    if (op === "remove" && !facts.pluginRemovalProof) return { automatic: false, reason: "plugin-local data restore not yet proven on this Paseo version" };
  }
  if (category === "config" && key === "setting:skills.selection" && !facts.selectionPatchable)
    return { automatic: false, reason: "capability: selection not patchable" };
  return { automatic: true };
}
