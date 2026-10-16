import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import type { z } from "zod";
import { conflictsListRpc, conflictsResolveRpc } from "../../shared/rpc.ts";
import { stateColor } from "../theme.tsx";
import { Button, errText } from "./common.tsx";

type Conflict = z.output<typeof conflictsListRpc.output>["conflicts"][number];

// No automatic merge: the operator keeps the destination copy (it stops following the source) or takes the source
// (the destination copy is backed up first).
export function ConflictsTab({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const list = useRpc(conflictsListRpc), resolve = useRpc(conflictsResolveRpc);
  const [items, setItems] = useState<Conflict[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; state: string } | null>(null);
  const refresh = useCallback(() => list({}).then(r => setItems(r.conflicts), e => setMessage({ text: `Could not load conflicts: ${errText(e)}`, state: "failed" })), [list]);
  useEffect(() => { void refresh(); }, [refresh]);
  const muted = { color: theme.colors.foregroundMuted };
  if (!items) return <Text style={muted}>Loading…</Text>;
  const act = async (c: Conflict, choice: "keep-destination" | "take-source") => {
    try {
      const r = await resolve({ setId: c.setId, key: c.key, choice });
      setMessage({ text: `${c.key}: ${r.state}${r.detail ? ` — ${r.detail}` : ""}`, state: r.state });
      await refresh();
    } catch (e) { setMessage({ text: `${c.key}: ${errText(e)}`, state: "failed" }); }
  };
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      {items.length === 0 ? <Text style={muted}>No conflicts.</Text> : items.map(c => (
        <View key={`${c.setId}:${c.key}`} accessibilityLabel={`Conflict ${c.key}`} style={{ gap: 4, padding: compact ? 8 : 10, borderWidth: 1, borderRadius: 8, borderColor: theme.colors.border }}>
          <Text style={{ color: theme.colors.foreground }}>{c.setId} · {c.key}</Text>
          <Text style={{ color: stateColor(theme, c.state) }}>{c.state}{c.detail ? ` — ${c.detail}` : ""}</Text>
          <Text style={muted}>desired {c.desiredDigest?.slice(0, 19) ?? "—"} · actual {c.actualDigest?.slice(0, 19) ?? "—"}</Text>
          {open === c.key && c.compare ? (
            <Text style={muted}>Compared with the source: added {c.compare.added.join(", ") || "none"}; removed {c.compare.removed.join(", ") || "none"}; changed {c.compare.changed.join(", ") || "none"}</Text>
          ) : null}
          <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
            <Button theme={theme} quiet label={`Keep destination ${c.key}`} onPress={() => { void act(c, "keep-destination"); }} />
            <Button theme={theme} label={`Take source ${c.key}`} onPress={() => { void act(c, "take-source"); }} />
            <Button theme={theme} quiet label={`Compare ${c.key}`} onPress={() => setOpen(open === c.key ? null : c.key)} />
          </View>
        </View>
      ))}
      {message ? <Text accessibilityRole={message.state === "failed" ? "alert" : "text"} style={{ color: stateColor(theme, message.state) }}>{message.text}</Text> : null}
    </View>
  );
}
