import { Events, type GuildMember } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { configManager } from "../../config/manager.js";
import { getPluginSettings } from "../../core/permissionRoles.js";
import { zTicketsConfig, type TicketCategory, type TicketsConfig } from "../../config/schemas/tickets.js";
import { ticketCommands } from "./commands/ticket.js";
import { processInactiveTickets } from "./functions/autoclose.js";
import { processTicketEscalations } from "./functions/escalation.js";
import { getTicketByChannel, touchActivity, touchStaffReply } from "./functions/tickets.js";

const AUTOCLOSE_SWEEP_INTERVAL_MS = 5 * 60_000;
const ESCALATION_SWEEP_INTERVAL_MS = 60_000;

/** Support roles for a ticket's category, falling back to the plugin-wide staff roles. */
function staffRoleIdsFor(category: TicketCategory | undefined, pluginConfig: TicketsConfig): string[] {
  const roles = category?.support_role_ids.filter(Boolean) ?? [];
  return roles.length ? roles : pluginConfig.staff_role_ids.filter(Boolean);
}

export const ticketsPlugin = definePlugin({
  name: "tickets",
  configSchema: zTicketsConfig,
  slashCommands: ticketCommands,
  onLoad: async ({ client }) => {
    setInterval(() => {
      processInactiveTickets(client).catch((err) => {
        console.error("Ticket auto-close sweep failed:", err);
      });
    }, AUTOCLOSE_SWEEP_INTERVAL_MS);
    setInterval(() => {
      processTicketEscalations(client).catch((err) => {
        console.error("Ticket escalation sweep failed:", err);
      });
    }, ESCALATION_SWEEP_INTERVAL_MS);
  },
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message;
        if (!msg.guild || msg.author.bot) return;

        const ticket = await getTicketByChannel(msg.guild.id, msg.channel.id).catch(() => null);
        if (!ticket || ticket.status !== "open") return;

        const guildConfig = await configManager.getEffectiveConfig(msg.guild.id).catch(() => null);
        if (!guildConfig) return;
        const pluginConfig = zTicketsConfig.parse(getPluginSettings(guildConfig, "tickets"));
        const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
        const category = panel?.categories.find((c) => c.id === ticket.categoryId);
        const staffRoleIds = staffRoleIdsFor(category, pluginConfig);

        const member = msg.member as GuildMember | null;
        const isStaff = Boolean(member && staffRoleIds.some((id) => member.roles.cache.has(id)));

        if (isStaff) {
          await touchStaffReply(msg.guild.id, msg.channel.id).catch(() => null);
        } else {
          await touchActivity(msg.guild.id, msg.channel.id).catch(() => null);
        }
      },
    },
  ],
});
