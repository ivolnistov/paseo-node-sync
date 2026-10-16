import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { OverviewTab } from "./tabs/overview.tsx";
import { PeerTab } from "./tabs/peer.tsx";
import { EnrollTab } from "./tabs/enroll.tsx";
import { ConflictsTab } from "./tabs/conflicts.tsx";
import { HistoryTab } from "./tabs/history.tsx";

const TABS = ["Overview", "Enroll", "Conflicts", "History", "Peer"] as const;
type Tab = (typeof TABS)[number];

export function NodeSyncScreen({ theme, layout }: PluginScreenProps) {
  const [tab, setTab] = useState<Tab>("Overview");
  const compact = layout.compact;
  const styles = useMemo(() => ({
    root: { flex: 1, padding: compact ? 12 : 20, gap: compact ? 10 : 16, backgroundColor: theme.colors.surface0 },
    tab: (active: boolean) => ({ paddingVertical: 6, paddingHorizontal: compact ? 10 : 14, borderRadius: 8,
      backgroundColor: active ? theme.colors.accent : theme.colors.surface1 }),
    tabText: (active: boolean) => ({ color: active ? theme.colors.accentForeground : theme.colors.foreground }),
  }), [theme, compact]);
  return (
    <View style={styles.root}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {TABS.map(t => (
          <Pressable key={t} accessibilityRole="tab" accessibilityLabel={`${t} tab`} accessibilityState={{ selected: tab === t }} onPress={() => setTab(t)} style={styles.tab(tab === t)}>
            <Text style={styles.tabText(tab === t)}>{t}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
        {tab === "Overview" ? <OverviewTab theme={theme} compact={compact} />
          : tab === "Peer" ? <PeerTab theme={theme} compact={compact} />
          : tab === "Enroll" ? <EnrollTab theme={theme} compact={compact} />
          : tab === "Conflicts" ? <ConflictsTab theme={theme} compact={compact} />
          : <HistoryTab theme={theme} compact={compact} />}
      </ScrollView>
    </View>
  );
}
