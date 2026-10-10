import { PermissionFlagsBits, type GuildMember } from "discord.js";
import { canUseTickets, getTicketsPluginConfig } from "../../../../core/guildHelpers.js";
import { resultEdit, resultReply, slashResultOptions } from "../../../../core/responses.js";
import type { SlashCommandContext } from "../../../../core/types.js";
import type { TicketsConfig } from "../../../../config/schemas/tickets.js";
import { getTicketByChannel } from "../tickets.js";
import { staffRoleIdsFor } from "./context.js";
import { usageSummary } from "./quota.js";
import { AI_EMOJI, findCategory, resumeTicketAi, stopTicketAi } from "./responder.js";
import { getTicketAiState } from "./store.js";

/** /ticket ai stop | resume | usage */
export async function handleTicketAiCommand(ctx: SlashCommandContext, sub: string): Promise<void> {
  const { interaction } = ctx;
  const guild = interaction.guild!;
  const member = interaction.member as GuildMember;
  const pluginConfig = (await getTicketsPluginConfig(guild.id, ctx.guildConfig, member)) as TicketsConfig;
  const reply = (title: string, body: string, tone: "success" | "warning" | "error" | "neutral" = "neutral") =>
    interaction.reply(resultReply(title, body, true, slashResultOptions(ctx, { tone, emoji: AI_EMOJI })));

  if (sub === "usage") {
    const usage = await usageSummary(guild.id);
    const resets = Math.floor(new Date(usage.resetsAt).getTime() / 1000);
    const left = Math.max(0, usage.replies.limit - usage.replies.used);
    await reply(
      "AI Responder usage",
      [
        `**${usage.replies.used.toLocaleString()} / ${usage.replies.limit.toLocaleString()}** AI replies used today (${left.toLocaleString()} left).`,
        `Handed to staff today: **${usage.escalations}** · Solved by the AI today: **${usage.resolved}**`,
        `Background learning: ${usage.background.used} / ${usage.background.limit}`,
        `Resets <t:${resets}:R>.`,
        usage.oneActive
          ? "This server has Dreamliner One: 1,000 AI replies a day."
          : "Free servers get 20 AI replies a day. Dreamliner One raises that to 1,000.",
        pluginConfig.ai_responder.enabled ? "" : "The AI Responder is turned off for this server.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  const ticket = await getTicketByChannel(guild.id, interaction.channelId!);
  if (!ticket || ticket.status !== "open") {
    await reply("Not an open ticket", "Use this inside an open ticket.", "warning");
    return;
  }
  const category = findCategory(pluginConfig, ticket);
  const isTicketStaff =
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    staffRoleIdsFor(category, pluginConfig).some((id) => member.roles.cache.has(id)) ||
    (await canUseTickets(guild.id, ctx.guildConfig, "can_control_ai", member));
  if (!isTicketStaff) {
    await reply("Staff only", "Only this ticket's staff can stop or resume the AI.", "error");
    return;
  }

  const state = getTicketAiState(ticket.id);
  if (sub === "stop") {
    if (!state || state.mode !== "ai") {
      await reply("Already with staff", "The AI isn't handling this ticket, so there's nothing to stop.", "warning");
      return;
    }
    stopTicketAi(ticket, member.id);
    await reply("AI stopped", "The AI won't reply in this ticket any more. Use `/ticket ai resume` to hand it back.", "success");
    return;
  }

  // resume
  if (!pluginConfig.ai_responder.enabled) {
    await reply("AI Responder is off", "Turn the AI Responder on from the dashboard first.", "warning");
    return;
  }
  if (state?.mode === "ai") {
    await reply("Already handling it", "The AI is already handling this ticket.", "warning");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await resumeTicketAi({ client: ctx.client, guild, guildConfig: ctx.guildConfig, pluginConfig, ticket, category }, member.id);
  await interaction.editReply(
    resultEdit("AI resumed", "The AI is back on this ticket and will answer the member's next message.", slashResultOptions(ctx, { tone: "success", emoji: AI_EMOJI })),
  );
}
