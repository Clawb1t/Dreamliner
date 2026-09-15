import { MessageFlags, type Client, type Guild } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { baseEmbed, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import { containerReply, pingComponent } from "../../../core/responses.js";
import { zTicketsConfig, type TicketCategory, type TicketEscalationStep, type TicketsConfig } from "../../../config/schemas/tickets.js";
import { listOpenTickets, setEscalationStep, setPriority, type TicketRecord } from "./tickets.js";
import { performClose } from "./actions.js";
import { getLogger } from "../../../core/logger.js";
import { defaultTranslator as t } from "../../../i18n/index.js";
const log = getLogger("tickets");

async function getTicketsConfigForGuild(guildId: string): Promise<TicketsConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return zTicketsConfig.parse(getPluginSettings(guildConfig, "tickets"));
}

async function applyEscalationStep(
  client: Client,
  guild: Guild,
  pluginConfig: TicketsConfig,
  category: TicketCategory,
  ticket: TicketRecord,
  step: TicketEscalationStep,
): Promise<void> {
  const targetChannelId = ticket.threadId ?? ticket.channelId;

  if (step.action === "ping_role" && step.role_id) {
    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      const embed = setEmbedAuthor(baseEmbed(), t("tickets.escalation.needsAttentionTitle", "Ticket #{num} needs attention", { num: ticket.number }), client, { tone: "warning" });
      embed.setDescription(
        step.message.trim() ||
          t("tickets.escalation.noReplyBody", "This ticket has gone {minutes}+ minutes without a staff reply.", {
            minutes: step.after_minutes,
          }),
      );
      // Components V2 messages can't carry `content`, so the ping lives in its own text
      // component ahead of the container. No `allowedMentions` override here — this is the
      // one escalation action that's supposed to ping.
      const payload = containerReply(embed);
      await channel
        .send({
          flags: MessageFlags.IsComponentsV2,
          components: [pingComponent(`<@&${step.role_id}>`), ...payload.components!],
        })
        .catch(() => null);
    }
    return;
  }

  if (step.action === "notify_channel" && step.channel_id) {
    const channel = await client.channels.fetch(step.channel_id).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      const embed = setEmbedAuthor(baseEmbed(), t("tickets.escalation.escalatedTitle", "Ticket #{num} escalated", { num: ticket.number }), client, { tone: "warning" });
      embed.addFields(
        embedField(t("tickets.escalation.categoryLabel", "Category"), category.label || t("tickets.escalation.unknownLabel", "Unknown"), true),
        embedField(t("tickets.escalation.waitingLabel", "Waiting"), t("tickets.escalation.waitingValue", "{minutes}+ minutes", { minutes: step.after_minutes }), true),
        embedField(t("tickets.escalation.channelLabel", "Channel"), `<#${targetChannelId}>`),
      );
      if (step.message.trim()) embed.addFields(embedField(t("tickets.escalation.noteLabel", "Note"), step.message.trim()));
      await channel.send(containerReply(embed)).catch(() => null);
    }
    return;
  }

  if (step.action === "set_priority" && step.priority) {
    await setPriority(ticket.guildId, ticket.id, step.priority);
    return;
  }

  if (step.action === "close") {
    const guildConfig = await configManager.getEffectiveConfig(ticket.guildId);
    await performClose(
      client,
      guild,
      guildConfig,
      pluginConfig,
      category,
      ticket,
      client.user!.id,
      step.message.trim() ||
        t("tickets.escalation.autoClosedReason", "Auto-closed: no staff reply after {minutes} minutes.", {
          minutes: step.after_minutes,
        }),
      t,
    );
  }
}

/**
 * SLA sweep: for every open ticket, checks its category's escalation ladder against how long
 * it's been since a staff member last replied (or since it opened, if staff never replied), and
 * fires the next unfired step once due. Steps fire in `after_minutes` order, one per tick, so a
 * long bot outage won't fire a burst of stale pings — it just catches up one step at a time.
 */
export async function processTicketEscalations(client: Client): Promise<void> {
  const openTickets = await listOpenTickets(2000);
  if (!openTickets.length) return;

  const byGuild = new Map<string, TicketRecord[]>();
  for (const ticket of openTickets) {
    const list = byGuild.get(ticket.guildId);
    if (list) list.push(ticket);
    else byGuild.set(ticket.guildId, [ticket]);
  }

  for (const [guildId, guildTickets] of byGuild) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;

    let pluginConfig: TicketsConfig;
    try {
      pluginConfig = await getTicketsConfigForGuild(guildId);
    } catch {
      continue;
    }

    for (const ticket of guildTickets) {
      const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
      const category = panel?.categories.find((c) => c.id === ticket.categoryId);
      if (!category || category.escalation.length === 0) continue;

      const nextIndex = ticket.escalationStep + 1;
      const sorted = [...category.escalation].sort((a, b) => a.after_minutes - b.after_minutes);
      if (nextIndex >= sorted.length) continue;

      const step = sorted[nextIndex]!;
      const silenceStart = ticket.lastStaffReplyAt ?? ticket.createdAt;
      const silenceMinutes = (Date.now() - silenceStart.getTime()) / 60_000;
      if (silenceMinutes < step.after_minutes) continue;

      try {
        await applyEscalationStep(client, guild, pluginConfig, category, ticket, step);
      } catch (err) {
        log.error(`Ticket escalation step failed for ticket #${ticket.number} in guild ${guildId}:`, err);
      }
      // Advance the pointer even if the step's own action failed above — a broken role/channel
      // config shouldn't wedge the ladder and re-fire the same broken step every sweep forever.
      await setEscalationStep(guildId, ticket.id, nextIndex).catch(() => null);
    }
  }
}
