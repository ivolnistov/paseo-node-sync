import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { nodeInitRpc } from "../../shared/rpc.ts";

// First-run identity. The approved design fixes the roles: the home Mac owns the registry, the work Mac follows.
// Identity cannot be changed after setup (the daemon refuses a second, different init).
const CHOICES = [
  { nodeId: "home", role: "owner" as const, label: "Set up as home (registry owner)",
    explain: "This node keeps the authoritative list of sync sets. Choose this on the home Mac." },
  { nodeId: "work", role: "follower" as const, label: "Set up as work (follower)",
    explain: "This node receives the set list from home and asks home to change it. Choose this on the work Mac." },
];

export function SetupCard({ theme, compact, onDone }: { theme: PluginTheme; compact: boolean; onDone: () => void }) {
  const init = useRpc(nodeInitRpc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (c: (typeof CHOICES)[number]) => {
    setBusy(true); setError(null);
    try {
      const r = await init({ nodeId: c.nodeId, role: c.role });
      if (r.ok) onDone();
      else setError(r.error === "already-initialized" ? "This node is already set up with a different identity; it cannot be changed." : `Setup failed: ${r.error}`);
    } catch (e) {
      setError(`Setup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };
  return (
    <View accessibilityLabel="Node setup" style={{ gap: compact ? 8 : 12, padding: compact ? 10 : 14, borderWidth: 1, borderRadius: 8,
      borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <Text style={{ color: theme.colors.foreground }}>This node is not set up yet.</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>Pick its identity once. It cannot be changed later.</Text>
      <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
        {CHOICES.map(c => (
          <View key={c.nodeId} style={{ flex: compact ? undefined : 1, gap: 6 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={c.label} disabled={busy} onPress={() => { void choose(c); }}
              style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: busy ? theme.colors.surface2 : theme.colors.accent }}>
              <Text style={{ color: theme.colors.accentForeground }}>{c.label}</Text>
            </Pressable>
            <Text style={{ color: theme.colors.foregroundMuted }}>{c.explain}</Text>
          </View>
        ))}
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </View>
  );
}
