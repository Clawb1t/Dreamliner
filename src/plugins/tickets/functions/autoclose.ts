import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zTicketsConfig } from "../../../config/schemas/tickets.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { ticketsDefaultOverrides } from "../defaultOverrides.js";
import { performClose } from "./actions.js";
import { getExpiredInactiveTickets } from "./tickets.js";

const HOUR_MS = 60 * 60 * 1000;

/** Auto-closes tickets past their category's configured hours of opener inactivity. Called ~every 5 minutes. */
export async function processInactiveTickets(client: Client): Promise<void> {
  const candidates = await getExpiredInactiveTickets();
  const now = Date.now();

  for (const ticket of candidates) {
    try {
      const guild = await client.guilds.fetch(ticket.guildId).catch(() => null);
      if (!guild) continue;

      const guildConfig = await configManager.getEffectiveConfig(ticket.guildId);
      if (!pluginEnabled(guildConfig, "tickets")) continue;

      const config = zTicketsConfig.parse(resolvePluginConfig(guildConfig, "tickets", ticketsDefaultOverrides));
      const panel = config.panels.find((p) => p.id === ticket.panelId);
      const category = panel?.categories.find((c) => c.id === ticket.categoryId);
      if (!category || !category.auto_close_hours || category.auto_close_hours <= 0) continue;

      const thresholdMs = category.auto_close_hours * HOUR_MS;
      if (now - ticket.lastActivityAt.getTime() < thresholdMs) continue;

      await performClose(
        client,
        guild,
        guildConfig,
        config,
        category,
        ticket,
        client.user?.id ?? ticket.openerId,
        "Automatically closed after prolonged inactivity.",
      );
    } catch (err) {
      console.error(`Ticket auto-close failed for ticket #${ticket.id}:`, err);
    }
  }
}
