import { Pressable, Text } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Button({ theme, label, onPress, disabled, quiet }: { theme: PluginTheme; label: string; onPress: () => void; disabled?: boolean; quiet?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: quiet ? 1 : 0, borderColor: theme.colors.border,
        backgroundColor: disabled ? theme.colors.surface2 : quiet ? theme.colors.surface1 : theme.colors.accent }}>
      <Text style={{ color: quiet || disabled ? theme.colors.foreground : theme.colors.accentForeground }}>{label}</Text>
    </Pressable>
  );
}
