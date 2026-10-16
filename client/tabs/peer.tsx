import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { peerAdmitRpc, peerEnrollRpc, peerListRpc, peerTestRpc } from "../../shared/rpc.ts";
import { stateColor } from "../theme.tsx";

const FIELDS = ["peerId", "hostKey", "publicKey", "registryRole", "host", "port", "user", "keyPath"] as const;
type Form = Record<(typeof FIELDS)[number], string>;
const LABELS: Form = { peerId: "Peer id", hostKey: "Peer host key (ssh-ed25519 …)", publicKey: "Peer public key (ssh-ed25519 …)",
  registryRole: "Peer registry role (owner | follower | none)", host: "Host", port: "SSH port", user: "SSH user",
  keyPath: "Path to this node's private key (only the path is stored)" };

export function PeerTab({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const list = useRpc(peerListRpc), enroll = useRpc(peerEnrollRpc), admit = useRpc(peerAdmitRpc), test = useRpc(peerTestRpc);
  const [peers, setPeers] = useState<Awaited<ReturnType<typeof list>>["peers"]>([]);
  const [form, setForm] = useState<Form>({ peerId: "", hostKey: "", publicKey: "", registryRole: "follower", host: "", port: "22", user: "", keyPath: "" });
  const [admitSet, setAdmitSet] = useState("");
  const [direction, setDirection] = useState<"inbound" | "outbound">("inbound");
  const [message, setMessage] = useState<{ text: string; state: string } | null>(null);
  const fail = (what: string, e: unknown) => setMessage({ text: `${what}: ${e instanceof Error ? e.message : String(e)}`, state: "failed" });
  const refresh = useCallback(() => list({}).then(r => setPeers(r.peers), e => fail("Could not load peers", e)), [list]);
  useEffect(() => { void refresh(); }, [refresh]);

  const input = { color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6, padding: compact ? 6 : 8,
    backgroundColor: theme.colors.surface1 };
  const button = (label: string, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.accent }}>
      <Text style={{ color: theme.colors.accentForeground }}>{label}</Text>
    </Pressable>
  );
  const onEnroll = async () => {
    try {
      const r = await enroll({ peerId: form.peerId, hostKey: form.hostKey.trim(), publicKey: form.publicKey.trim(),
        registryRole: form.registryRole as "owner" | "follower" | "none",
        endpoint: form.host ? { host: form.host, port: Number(form.port), user: form.user, keyPath: form.keyPath } : undefined });
      setMessage(r.ok ? { text: `Enrolled ${r.peer.peerId} (${r.peer.fingerprint})`, state: "idle" } : { text: `Enroll failed: ${r.error}`, state: "failed" });
      void refresh();
    } catch (e) { fail("Enroll failed", e); }
  };


  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      {peers.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted }}>No peers enrolled.</Text> : peers.map(p => (
        <View key={p.peerId} style={{ gap: 6, padding: compact ? 8 : 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 }}>
          <Text style={{ color: theme.colors.foreground }}>{p.peerId} · registry {p.registryRole} · key {p.fingerprint}</Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {p.endpoint ? `${p.endpoint.user}@${p.endpoint.host}:${p.endpoint.port}` : "no endpoint"} · host key {p.hostKeyFingerprint}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>
            Admitted: {p.sets.length ? p.sets.map(s => `${s.setId} (${s.direction})`).join(", ") : "none"}
          </Text>
          <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
            {button("Test connection", async () => {
              try {
                const r = await test({ peerId: p.peerId });
                setMessage(r.ok ? { text: `${p.peerId}: ${r.hello.nodeId}, protocol ${r.hello.protocol}, ${r.latencyMs} ms`, state: "connected" }
                  : { text: `${p.peerId}: ${r.error}${r.detail ? ` — ${r.detail}` : ""}`, state: "failed" });
              } catch (e) { fail(`${p.peerId}: test failed`, e); }
            })}
            <TextInput value={admitSet} onChangeText={setAdmitSet} placeholder="set id" placeholderTextColor={theme.colors.foregroundMuted}
              style={[input, { minWidth: 120 }]} accessibilityLabel="Set id to admit" />
            {(["inbound", "outbound"] as const).map(d => (
              <Pressable key={d} accessibilityRole="radio" accessibilityState={{ selected: direction === d }} accessibilityLabel={`Direction ${d}`}
                onPress={() => setDirection(d)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1,
                  borderColor: direction === d ? theme.colors.accent : theme.colors.border }}>
                <Text style={{ color: theme.colors.foreground }}>{d === "inbound" ? "Inbound (this node receives)" : "Outbound (this node sends)"}</Text>
              </Pressable>
            ))}
            {button(`Admit ${direction} set`, async () => {
              try {
                const r = await admit({ peerId: p.peerId, setId: admitSet, direction });
                setMessage(r.ok ? { text: `Admitted ${admitSet} (${direction}) for ${p.peerId}`, state: "idle" } : { text: `Admit failed: ${r.error}`, state: "failed" });
                void refresh();
              } catch (e) { fail("Admit failed", e); }
            })}
          </View>
        </View>
      ))}
      {message ? <Text accessibilityRole={message.state === "failed" ? "alert" : "text"} style={{ color: stateColor(theme, message.state) }}>{message.text}</Text> : null}
      <Text style={{ color: theme.colors.foreground, marginTop: 8 }}>Enroll or re-pin a peer</Text>
      {FIELDS.map(f => (
        <TextInput key={f} value={form[f]} onChangeText={v => setForm({ ...form, [f]: v })} placeholder={LABELS[f]} accessibilityLabel={LABELS[f]}
          placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={input} />
      ))}
      {button("Enroll", () => { void onEnroll(); })}
    </View>
  );
}
