import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import type { z } from "zod";
import { historyListRpc, itemResumeRpc, itemRollbackRpc } from "../../shared/rpc.ts";
import { stateColor } from "../theme.tsx";
import { Button, errText } from "./common.tsx";

type History = z.output<typeof historyListRpc.output>;

// Roll back restores a backup through the normal applier and pauses the item; Resume follows the source again.
export function HistoryTab({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const list = useRpc(historyListRpc), rollback = useRpc(itemRollbackRpc), resume = useRpc(itemResumeRpc);
  const [h, setH] = useState<History | null>(null);
  const [message, setMessage] = useState<{ text: string; state: string } | null>(null);
  const refresh = useCallback(() => list({}).then(setH, e => setMessage({ text: `Could not load history: ${errText(e)}`, state: "failed" })), [list]);
  useEffect(() => { void refresh(); }, [refresh]);
  const muted = { color: theme.colors.foregroundMuted }, text = { color: theme.colors.foreground };
  if (!h) return <Text style={muted}>Loading…</Text>;
  const run = async (what: string, fn: () => Promise<{ state?: string; detail?: string } | { ok: true }>) => {
    try {
      const r = await fn();
      const state = "state" in r && r.state ? r.state : "idle";
      setMessage({ text: `${what}: ${state}${"detail" in r && r.detail ? ` — ${r.detail}` : ""}`, state });
      await refresh();
    } catch (e) { setMessage({ text: `${what}: ${errText(e)}`, state: "failed" }); }
  };
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <Text style={text}>Items</Text>
      {h.items.length === 0 ? <Text style={muted}>No items received yet.</Text> : h.items.map(i => (
        <View key={`${i.setId}:${i.key}`} style={{ flexDirection: compact ? "column" : "row", gap: 8, alignItems: compact ? "stretch" : "center" }}>
          <Text style={{ color: stateColor(theme, i.state) }}>{i.setId} · {i.key} · {i.state}{i.generation ? ` · g${i.generation}` : ""}</Text>
          {i.state === "paused" ? <Button theme={theme} label={`Resume ${i.key}`} onPress={() => { void run(`Resume ${i.key}`, () => resume({ setId: i.setId, key: i.key })); }} /> : null}
        </View>
      ))}
      <Text style={text}>Backups</Text>
      {h.backups.length === 0 ? <Text style={muted}>No backups.</Text> : h.backups.map(b => (
        <View key={b.backupId} style={{ flexDirection: compact ? "column" : "row", gap: 8, alignItems: compact ? "stretch" : "center" }}>
          <Text style={muted}>{b.key} · g{b.generation} · {b.restorable}{b.digest ? "" : " · absent before"} · {b.backupId}</Text>
          <Button theme={theme} quiet label={`Roll back ${b.key} to ${b.backupId}`} onPress={() => { void run(`Roll back ${b.key}`, () => rollback({ setId: b.setId, key: b.key, backupId: b.backupId })); }} />
        </View>
      ))}
      <Text style={text}>Generations</Text>
      {h.generations.length === 0 ? <Text style={muted}>No generations yet.</Text> : h.generations.map(g => (
        <Text key={`${g.side}:${g.setId}:${g.generation}`} style={muted}>
          {g.setId} · {g.side} · g{g.generation} · {g.status}{g.supersededBy ? ` (superseded by g${g.supersededBy})` : ""} · {g.items.map(i => `${i.key}: ${i.state}`).join(", ") || "no items"}
        </Text>
      ))}
      {message ? <Text accessibilityRole={message.state === "failed" ? "alert" : "text"} style={{ color: stateColor(theme, message.state) }}>{message.text}</Text> : null}
    </View>
  );
}
