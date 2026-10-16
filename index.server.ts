import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startNodeSync } from "./server/rpc-handlers.ts";

export default function contribute(server: PluginServerContext) {
  return startNodeSync(server);
}
