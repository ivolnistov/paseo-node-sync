import { useEffect, useState } from "react";
import type { z } from "zod";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { holdClearRpc, overviewRpc } from "../../shared/rpc.ts";
import { Button, errText } from "./common.tsx";
import { stateColor } from "../theme.tsx";
import { SetupCard } from "./setup.tsx";

type Overview = z.output<typeof overviewRpc.output>;

export function OverviewTab({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const load = useRpc(overviewRpc);
  const clearHold = useRpc(holdClearRpc);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let live = true;
    const tick = () => load({}).then(d => { if (live) { setData(d); setError(null); } },
      e => { if (live) setError(`Could not load node status: ${e instanceof Error ? e.message : String(e)}`); });
    tick();
    const t = setInterval(tick, 5000);
    return () => { live = false; clearInterval(t); };
  }, [load, refreshKey]);
  const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
  if (error) return <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text>;
  if (!data) return <Text style={muted}>Loading…</Text>;
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      {data.node ? null : <SetupCard theme={theme} compact={compact} onDone={() => setRefreshKey(k => k + 1)} />}
      <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
        <Text style={text}>Node: {data.node ? `${data.node.nodeId} (${data.node.role === "owner" ? "registry owner" : "follower"})` : "not set up"}</Text>
        <Text style={muted}>Registry r{data.registry.revision}, owner {data.registry.ownerNodeId || "—"}</Text>
      </View>
      <Text style={{ color: stateColor(theme, data.session.state) }}>
        Daemon session: {data.session.state}{data.session.detail ? ` — ${data.session.detail}` : ""}
      </Text>
      {data.worker.lastError ? <Text style={{ color: theme.colors.statusDanger }}>Worker: {data.worker.lastError}</Text> : null}
      {data.worker.recoveryPending ? <Text style={{ color: theme.colors.statusDanger }}>Recovery has not completed: nothing is applied on this node until it does.</Text> : null}
      {(data.worker.holds ?? []).map(h => (
        <View key={h.file} style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.statusDanger }}>
            Held ({h.scope === "node" ? "whole node" : h.setId}): {h.reason}. Evidence kept in journal/.invalid/{h.file}. Nothing is applied {h.scope === "node" ? "on this node" : "for this set"} until you repair and clear it.
          </Text>
          <Button theme={theme} quiet label={`Clear hold ${h.file} (after repair)`} onPress={() => {
            void clearHold({ file: h.file }).then(() => setRefreshKey(k => k + 1), e => setError(`Could not clear the hold: ${errText(e)}`));
          }} />
        </View>
      ))}
      {data.runtime.map(r => (
        <Text key={`${r.side}:${r.setId}`} style={{ color: stateColor(theme, r.state) }}>
          {r.setId} ({r.side}): {r.state}{r.paused ? " (paused)" : ""} · g{r.generation}{r.detail ? ` — ${r.detail}` : ""}
          {r.delivery && r.delivery.state !== r.state ? ` · delivery: ${r.delivery.state} — ${r.delivery.detail}` : ""}
        </Text>
      ))}
      {data.requests.map(q => (
        <Text key={q.requestId} style={{ color: stateColor(theme, q.status === "rejected" ? "failed" : q.status === "applied" ? "idle" : "pending") }}>
          Request {q.summary}: {q.status}{q.revision !== undefined ? ` (registry r${q.revision})` : ""}{q.error ? ` — ${q.error}` : ""}
        </Text>
      ))}
      {data.sets.length === 0 ? <Text style={muted}>No sync sets yet.</Text> : data.sets.map(s => (
        <View key={s.id} style={{ flexDirection: compact ? "column" : "row", justifyContent: "space-between", padding: compact ? 8 : 10,
          borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
          <Text style={text}>{s.id} · {s.category} · {s.source} → {s.destination} · {s.items} items</Text>
          <Text style={{ color: stateColor(theme, s.state) }}>{s.state}</Text>
        </View>
      ))}
    </View>
  );
}
