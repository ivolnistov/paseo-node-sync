import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import type { z } from "zod";
import { enrollSetRpc, enrollTreeRpc, overviewRpc, rootsAddRpc } from "../../shared/rpc.ts";
import { stateColor } from "../theme.tsx";
import { Button, errText } from "./common.tsx";

type Tree = Extract<z.output<typeof enrollTreeRpc.output>, { ok: true }>;

// Roots are discovery scope only: every skill is enrolled one by one, and new siblings start unchecked.
export function EnrollTab({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const overview = useRpc(overviewRpc), tree = useRpc(enrollTreeRpc), enroll = useRpc(enrollSetRpc), addRoot = useRpc(rootsAddRpc);
  const [sets, setSets] = useState<{ id: string; label: string }[]>([]);
  const [setId, setSetId] = useState<string | null>(null);
  const [data, setData] = useState<Tree | null>(null);
  const [rootPath, setRootPath] = useState("");
  const [trust, setTrust] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; state: string } | null>(null);

  useEffect(() => {
    overview({}).then(o => {
      const mine = o.sets.filter(s => s.source === o.node?.nodeId).map(s => ({ id: s.id, label: `${s.id} (${s.category}, ${s.source} → ${s.destination})` }));
      setSets(mine); setSetId(cur => cur ?? mine[0]?.id ?? null);
    }, e => setMessage({ text: `Could not load sets: ${errText(e)}`, state: "failed" }));
  }, [overview]);
  const refresh = useCallback(async () => {
    if (!setId) return;
    try {
      const r = await tree({ setId });
      if (r.ok) setData(r); else setMessage({ text: `Could not load ${setId}: ${r.error}`, state: "failed" });
    } catch (e) { setMessage({ text: `Could not load ${setId}: ${errText(e)}`, state: "failed" }); }
  }, [setId, tree]);
  useEffect(() => { void refresh(); }, [refresh]);

  const muted = { color: theme.colors.foregroundMuted }, text = { color: theme.colors.foreground };
  if (sets.length === 0) return <Text style={muted}>No sets have this node as their source. Create a set first; items are enrolled on the source node.</Text>;
  const isConfig = data?.category === "config";
  const basic = data?.candidates.filter(c => !c.advanced) ?? [], advanced = data?.candidates.filter(c => c.advanced) ?? [];
  const row = (c: Tree["candidates"][number]) => (
    <View key={`${c.root}:${c.key}`} style={{ gap: 4, padding: compact ? 6 : 8, borderWidth: 1, borderRadius: 8, borderColor: theme.colors.border }}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: c.enrolled, disabled: !!(c.managedBySet || c.blocked || c.unavailable) }}
        accessibilityLabel={`Enroll ${c.label}`} disabled={!!(c.managedBySet || c.blocked || c.unavailable)} onPress={() => { void toggle(c); }}>
        <Text style={text}>{c.enrolled ? "☑" : "☐"} {c.label}{c.state ? ` · ${c.state}` : ""}</Text>
      </Pressable>
      {c.value !== undefined && c.fullText === undefined ? <Text style={muted}>Current value: {c.value}</Text> : null}
      {c.managedBySet ? <Text style={muted}>managed by {c.managedBySet}</Text> : null}
      {c.unavailable ? <Text style={muted}>{c.unavailable}</Text> : null}
      {c.blocked ? <Text style={{ color: theme.colors.statusDanger }}>blocked: unsafe path — {c.blocked}</Text> : null}
      {previewKey === c.key && !isConfig ? <Text style={muted}>Files to send: {c.preview.join(", ") || "(none)"}. Press again to enroll.</Text> : null}
      {previewKey === c.key && c.fullText !== undefined ? <Text style={text}>Full text to send:{"\n"}{c.fullText || "(empty)"}{"\n"}Press again to enroll.</Text> : null}
      {previewKey === c.key && c.advanced ? <Text style={{ color: theme.colors.statusDanger }}>Advanced: the whole value replaces the destination's value. Press again to confirm.</Text> : null}
      {previewKey === c.key && isConfig && !c.advanced && c.fullText === undefined ? <Text style={muted}>Press again to enroll.</Text> : null}
    </View>
  );
  const toggle = async (c: Tree["candidates"][number]) => {
    // The first press shows what would be sent (files, the full text, or the Advanced warning); the second enrolls.
    if (!c.enrolled && previewKey !== c.key) { setPreviewKey(c.key); return; }
    try {
      const r = await enroll({ setId: setId!, key: c.key, enrolled: !c.enrolled, root: c.root,
        ...(!c.enrolled && c.advanced ? { confirmAdvanced: true } : {}), ...(!c.enrolled && c.fullText !== undefined ? { previewDigest: c.valueDigest } : {}) });
      setMessage(r.status === "rejected" ? { text: `${c.label}: ${r.error}`, state: "failed" }
        : { text: `${c.label}: ${c.enrolled ? "un-enrolled" : "enrolled"} (${r.status === "requested" ? "sent to the registry owner" : `registry r${r.revision}`})`, state: "idle" });
      setPreviewKey(null);
      await refresh();
    } catch (e) { setMessage({ text: `${c.label}: ${errText(e)}`, state: "failed" }); }
  };
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <View style={{ flexDirection: compact ? "column" : "row", gap: 8, flexWrap: "wrap" }}>
        {sets.map(s => <Button key={s.id} theme={theme} quiet={s.id !== setId} label={s.label} onPress={() => setSetId(s.id)} />)}
      </View>
      {isConfig ? null : data?.roots.map(r => (
        <Text key={r.realpath} style={{ color: r.readable ? theme.colors.foregroundMuted : theme.colors.statusDanger }}>
          Root {r.path}{r.path !== r.realpath ? ` (${r.realpath})` : ""}{r.readable ? "" : ` — unreadable: ${r.reason}; nothing is sent or deleted`}
        </Text>
      ))}
      {isConfig ? null : <View style={{ flexDirection: compact ? "column" : "row", gap: 8, alignItems: compact ? "stretch" : "center" }}>
        <TextInput value={rootPath} onChangeText={setRootPath} placeholder="Absolute path of a skills root" accessibilityLabel="Root path"
          placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false}
          style={{ flex: compact ? undefined : 1, color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6, padding: 6 }} />
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: trust }} accessibilityLabel="Trust this root" onPress={() => setTrust(!trust)}>
          <Text style={text}>{trust ? "☑" : "☐"} I trust files under this root to be sent</Text>
        </Pressable>
        <Button theme={theme} label="Add root" disabled={!rootPath} onPress={() => {
          addRoot({ setId: setId!, path: rootPath, confirmTrust: trust }).then(r => {
            setMessage(r.ok ? { text: `Root added (${r.realpath})`, state: "idle" } : { text: `Add root failed: ${r.error}${r.detail ? ` — ${r.detail}` : ""}`, state: "failed" });
            if (r.ok) { setRootPath(""); setTrust(false); void refresh(); }
          }, e => setMessage({ text: `Add root failed: ${errText(e)}`, state: "failed" }));
        }} />
      </View>}
      {basic.map(row)}
      {advanced.length ? <Text accessibilityRole="header" style={text}>Advanced</Text> : null}
      {advanced.map(row)}
      {message ? <Text accessibilityRole={message.state === "failed" ? "alert" : "text"} style={{ color: stateColor(theme, message.state) }}>{message.text}</Text> : null}
    </View>
  );
}
