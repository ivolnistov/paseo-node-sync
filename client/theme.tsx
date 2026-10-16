import type { PluginTheme } from "@getpaseo/plugin";

// Set and item states map onto the host theme's three status colours.
export function stateColor(theme: PluginTheme, state: string): string {
  if (state === "in-sync" || state === "idle" || state === "connected") return theme.colors.statusSuccess;
  if (state.startsWith("blocked") || state === "failed" || state === "peer-identity-changed" || state === "auth-required") return theme.colors.statusDanger;
  return theme.colors.statusWarning;
}
