import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultEdit, resultReply, slashResultOptions } from "../../../core/responses.js";
import { hasPluginPermission } from "../../../core/permissions.js";
import { getTicketsPluginConfig } from "../../../core/guildHelpers.js";
import { ticketsDefaultOverrides } from "../defaultOverrides.js";
import { requireTicketChannel, requireTicketPermission } from "../functions/commandHelpers.js";
import {
  addToBlacklist,
} from "../functions/blacklist.js";
import { canCloseTicket, createTicketForMember, performAddMember, performClaim, performClose, performRemoveMember, performUnclaim } from "../functions/actions.js";
import { renameTicket, setPriority } from "../functions/tickets.js";
import { dmTranscript, getLatestTranscriptForTicket, postTranscriptLog } from "../functions/transcripts.js";
import { postPanel } from "../functions/panels.js";
import { TICKET_PRIORITIES, type TicketsConfig } from "../../../config/schemas/tickets.js";

export const ticketCommands: SlashCommandDefinition[] = [
  {
    plugin: "tickets",
    data: new SlashCommandBuilder()
      .setName("ticket")
      .setDescription("Open and manage support tickets")
      .addSubcommand((sub) => sub.setName("new").setDescription("Open a new ticket (only when the server has exactly one panel/category)"))
      .addSubcommand((sub) =>
        sub
          .setName("close")
          .setDescription("Close the ticket in this channel")
          .addStringOption((o) => o.setName("reason").setDescription("Close reason")),
      )
      .addSubcommand((sub) => sub.setName("claim").setDescription("Claim the ticket in this channel"))
      .addSubcommand((sub) => sub.setName("unclaim").setDescription("Unclaim the ticket in this channel"))
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add a member to this ticket")
          .addUserOption((o) => o.setName("user").setDescription("Member to add").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a member from this ticket")
          .addUserOption((o) => o.setName("user").setDescription("Member to remove").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("rename")
          .setDescription("Rename this ticket's channel")
          .addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("priority")
          .setDescription("Set this ticket's priority")
          .addStringOption((o) =>
            o
              .setName("level")
              .setDescription("Priority level")
              .setRequired(true)
              .addChoices(...TICKET_PRIORITIES.map((p) => ({ name: p, value: p }))),
          ),
      )
      .addSubcommand((sub) => sub.setName("transcript").setDescription("Send this ticket's latest transcript to you"))
      .addSubcommandGroup((group) =>
        group
          .setName("panel")
          .setDescription("Manage ticket panels")
          .addSubcommand((sub) =>
            sub
              .setName("post")
              .setDescription("Post (or repost) a ticket panel")
              .addStringOption((o) => o.setName("panel_name").setDescription("The panel's dashboard name").setRequired(true)),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("blacklist")
          .setDescription("Block a member from opening tickets")
          .addUserOption((o) => o.setName("target").setDescription("Member to block").setRequired(true))
          .addStringOption((o) => o.setName("reason").setDescription("Reason")),
      ),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const guildId = interaction.guildId!;
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      if (group === "panel" && sub === "post") {
        const auth = await requireTicketPermission(ctx, "can_manage_panels");
        if (!auth) return;
        const panelName = interaction.options.getString("panel_name", true);
        const panel = auth.pluginConfig.panels.find((p) => p.name === panelName || p.id === panelName);
        if (!panel) {
          await interaction.reply(resultReply("Panel not found", `No panel named \`${panelName}\`.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await interaction.deferReply({ ephemeral: ctx.ephemeral });
        const messageId = await postPanel(ctx.client, guildId, panel);
        if (!messageId) {
          await interaction.editReply(resultEdit("Failed", "Could not post the panel. Check the panel's channel configuration.", slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await ctx.configManager.patchPluginConfig(
          guildId,
          "tickets",
          { panels: auth.pluginConfig.panels.map((p) => (p.id === panel.id ? { ...p, message_id: messageId } : p)) },
          interaction.user.id,
        );
        await interaction.editReply(resultEdit("Panel posted", `Posted \`${panel.name || panel.id}\` in <#${panel.channel_id}>.`, slashResultOptions(ctx, { tone: "success" })));
        return;
      }

      if (sub === "new") {
        const guildConfig = ctx.guildConfig;
        const pluginConfig = getTicketsPluginConfig(guildConfig) as TicketsConfig;
        const pairs = pluginConfig.panels
          .filter((p) => p.enabled)
          .flatMap((panel) => panel.categories.map((category) => ({ panel, category })));
        if (pairs.length !== 1) {
          await interaction.reply(
            resultReply(
              "Use the panel buttons",
              pairs.length === 0
                ? "No ticket panels are configured yet."
                : "This server has multiple ticket categories. Open a ticket from the panel message's buttons or menu instead.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }
        const { panel, category } = pairs[0]!;
        if (category.form_questions.length > 0) {
          await interaction.reply(
            resultReply("Use the panel", "This ticket category asks setup questions — open it from the panel message instead.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
          );
          return;
        }
        const member = interaction.member;
        if (!member || typeof member === "string") {
          await interaction.reply(resultReply("Member error", "Could not resolve member.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await createTicketForMember({
          client: ctx.client,
          guild: interaction.guild!,
          member: member as import("discord.js").GuildMember,
          panel,
          category,
          guildConfig,
          pluginConfig,
        });
        if ("error" in result) {
          await interaction.editReply(resultEdit("Cannot open ticket", result.error, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const target = result.ticket.threadId ?? result.ticket.channelId;
        await interaction.editReply(resultEdit("Ticket opened", `Your ticket is ready: <#${target}>.`, slashResultOptions(ctx, { tone: "success" })));
        return;
      }

      if (sub === "blacklist") {
        const auth = await requireTicketPermission(ctx, "can_blacklist");
        if (!auth) return;
        const target = interaction.options.getUser("target", true);
        const reason = interaction.options.getString("reason");
        await addToBlacklist(guildId, target.id, "user", reason);
        await interaction.reply(resultReply("Blacklisted", `${target.tag} can no longer open tickets.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })));
        return;
      }

      // Every remaining subcommand acts on the ticket tied to the current channel.
      const ticket = await requireTicketChannel(ctx);
      if (!ticket) return;

      if (sub === "claim" || sub === "unclaim") {
        const auth = await requireTicketPermission(ctx, "can_claim");
        if (!auth) return;
        if (sub === "claim") {
          await performClaim(ctx.client, ctx.guildConfig, auth.pluginConfig, ticket, interaction.user.id);
          await interaction.reply(resultReply("Ticket claimed", `You are now handling ticket #${ticket.number}.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })));
        } else {
          await performUnclaim(ticket);
          await interaction.reply(resultReply("Ticket unclaimed", `Ticket #${ticket.number} is now unclaimed.`, ctx.ephemeral, slashResultOptions(ctx)));
        }
        return;
      }

      if (sub === "close") {
        const pluginConfig = getTicketsPluginConfig(ctx.guildConfig, interaction.member as import("discord.js").GuildMember, interaction.channelId) as TicketsConfig;
        const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
        const category = panel?.categories.find((c) => c.id === ticket.categoryId);
        const isOpener = ticket.openerId === interaction.user.id;
        const isStaff = hasPluginPermission(ctx.guildConfig, "tickets", "can_close_others", interaction.member as import("discord.js").GuildMember, interaction.channelId, null, ticketsDefaultOverrides);
        const canCloseOwn = isOpener && hasPluginPermission(ctx.guildConfig, "tickets", "can_close", interaction.member as import("discord.js").GuildMember, interaction.channelId, null, ticketsDefaultOverrides);
        if (!canCloseTicket(category?.close_permission ?? "either", canCloseOwn, isStaff)) {
          await interaction.reply(resultReply("Permission denied", "You cannot close this ticket.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const reason = interaction.options.getString("reason");
        if (category?.require_close_reason && !reason?.trim()) {
          await interaction.reply(resultReply("Reason required", "This category requires a close reason.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await interaction.deferReply({ ephemeral: ctx.ephemeral });
        await performClose(ctx.client, interaction.guild!, ctx.guildConfig, pluginConfig, category, ticket, interaction.user.id, reason);
        await interaction.editReply(resultEdit("Ticket closed", `Ticket #${ticket.number} has been closed.`, slashResultOptions(ctx, { tone: "success" })));
        return;
      }

      if (sub === "add" || sub === "remove") {
        const auth = await requireTicketPermission(ctx, "can_add_remove_members");
        if (!auth) return;
        const target = interaction.options.getUser("user", true);
        const updated =
          sub === "add"
            ? await performAddMember(interaction.guild!, ticket, target.id)
            : await performRemoveMember(interaction.guild!, ticket, target.id);
        if (!updated) {
          await interaction.reply(resultReply("Failed", "Could not update ticket members.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await interaction.reply(
          resultReply(sub === "add" ? "Member added" : "Member removed", `${target.tag} has been ${sub === "add" ? "added to" : "removed from"} this ticket.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })),
        );
        return;
      }

      if (sub === "rename") {
        const auth = await requireTicketPermission(ctx, "can_manage_panels");
        if (!auth) return;
        const name = interaction.options.getString("name", true);
        const ok = await renameTicket(ctx.client, ticket, name);
        await interaction.reply(
          ok
            ? resultReply("Renamed", `Ticket #${ticket.number} renamed.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success" }))
            : resultReply("Failed", "Could not rename this ticket's channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      if (sub === "priority") {
        const auth = await requireTicketPermission(ctx, "can_claim");
        if (!auth) return;
        const level = interaction.options.getString("level", true) as (typeof TICKET_PRIORITIES)[number];
        await setPriority(guildId, ticket.id, level);
        await interaction.reply(resultReply("Priority updated", `Ticket #${ticket.number} priority set to **${level}**.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })));
        return;
      }

      if (sub === "transcript") {
        await interaction.deferReply({ ephemeral: ctx.ephemeral });
        const latest = await getLatestTranscriptForTicket(guildId, ticket.id);
        if (!latest) {
          await interaction.editReply(resultEdit("No transcript yet", "This ticket has no saved transcript yet — it's generated when the ticket closes.", slashResultOptions(ctx, { tone: "warning" })));
          return;
        }
        const sent = await dmTranscript(interaction.user, ticket, latest.id);
        if (!sent) {
          const pluginConfig = getTicketsPluginConfig(ctx.guildConfig) as TicketsConfig;
          const channelId = pluginConfig.default_transcript_channel_id;
          if (channelId) await postTranscriptLog(ctx.client, channelId, ticket, latest.id);
        }
        await interaction.editReply(
          resultEdit(
            sent ? "Transcript sent" : "Transcript posted",
            sent ? "Check your DMs for the transcript." : "Could not DM you — posted the transcript to the log channel instead.",
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
        return;
      }
    },
  },
];
