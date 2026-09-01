import { definePlugin } from "../../core/plugin.js";
import { debugCommands } from "./commands.js";

/**
 * Bot developer diagnostics — not a guild-configurable feature (no configSchema/defaultOverrides,
 * not listed in the dashboard or /help), so it's always "enabled" everywhere. Access is gated
 * per-command by isDashboardSuperuser, not the usual per-guild permission system, since its data
 * (e.g. /debug appemojis) is bot-wide, not scoped to any one server.
 */
export const debugPlugin = definePlugin({
  name: "debug",
  slashCommands: debugCommands,
});
