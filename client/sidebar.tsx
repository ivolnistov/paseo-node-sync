import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

// Opens the screen only; the worker's daemon session does not depend on the UI being open.
export function NodeSyncSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="RefreshCw" active={currentScreen?.screenId === "main"} onPress={() => openScreen({ screenId: "main" })} />;
}
