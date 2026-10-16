import { bundleDigest } from "../server/canonical.ts";
import type { DataBundle, DesiredItem } from "../shared/protocol.ts";

export const INC = "incarnation-1";
export const hex = (c: string) => `sha256:${c.repeat(64)}`;

export function bundle(g: number, items: DesiredItem[] = [], over: Partial<DataBundle> = {}): DataBundle {
  const b = { kind: "data", protocol: 1, capability: 1, setId: "skills-home", incarnation: INC,
    generation: g, complete: true, items, tombstones: [], released: [], ...over } as Omit<DataBundle, "digest">;
  return { ...b, digest: bundleDigest(b) } as DataBundle;
}
