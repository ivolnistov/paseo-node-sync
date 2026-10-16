import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NodeSyncScreen } from "./client/screen.tsx";
import { NodeSyncSidebarItem } from "./client/sidebar.tsx";

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({ id: "main", title: "Node sync", Component: NodeSyncScreen });
  const removeItem = client.addSidebarFooterItem({ id: "main", title: "Node sync", Component: NodeSyncSidebarItem });
  return () => { removeItem(); removeScreen(); };
}
