import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultEdit, resultReply, slashResultOptions } from "../../../core/responses.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { getTicketsPluginConfig } from "../../../core/guildHelpers.js";
import { requireTicketChannel, requireTicketPermission } from "../functions/commandHelpers.js";
import {
  addToBlacklist,
} from "../functions/blacklist.js";
import {
  canCloseTicket,
  createTicketForMember,
  performAddMember,
  performAssign,
  performClaim,
  performClose,
  performRemoveMember,
  performSetStatus,
  performUnassign,
  performUnclaim,
} from "../functions/actions.js";
import { getTicketHandlerStats, renameTicket, setPriority, type TicketHandlerStat } from "../functions/tickets.js";
import { dmTranscript, getLatestTranscriptForTicket, postTranscriptLog } from "../functions/transcripts.js";
import { formatDurationShort } from "../../infraction/functions/duration.js";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketStatus,
  type TicketsConfig,
} from "../../../config/schemas/tickets.js";

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
          .setName("assign")
          .setDescription("Assign the ticket in this channel to another member")
          .addUserOption((o) => o.setName("user").setDescription("Member to assign").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("unassign").setDescription("Unassign the ticket in this channel"))
      .addSubcommandGroup((group) =>
        group
          .setName("status")
          .setDescription("Change this ticket's status")
          .addSubcommand((sub) =>
            sub
              .setName("set")
              .setDescription("Set this ticket's status")
              .addStringOption((o) =>
                o
                  .setName("status")
                  .setDescription("New status")
                  .setRequired(true)
                  .addChoices(...TICKET_STATUSES.map((s) => ({ name: TICKET_STATUS_LABELS[s], value: s }))),
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("stats")
          .setDescription("Ticket handler performance stats")
          .addUserOption((o) => o.setName("member").setDescription("Only show this member's stats"))
          .addIntegerOption((o) => o.setName("days").setDescription("Only include tickets opened in the last N days").setMinValue(1)),
      )
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

      if (sub === "new") {
        const guildConfig = ctx.guildConfig;
        const pluginConfig = (await getTicketsPluginConfig(guildId, guildConfig)) as TicketsConfig;
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
        await interaction.editReply(resultEdit("Ticket opened", `Your ticket is ready: <#${target}>.`, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_ticket:1544417593191047179>" })));
        return;
      }

      if (sub === "blacklist") {
        const auth = await requireTicketPermission(ctx, "can_blacklist");
        if (!auth) return;
        const target = interaction.options.getUser("target", true);
        const reason = interaction.options.getString("reason");
        await addToBlacklist(guildId, target.id, "user", reason);
        await interaction.reply(resultReply("Blacklisted", `${target.tag} can no longer open tickets.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_ban:1544417486177308742>" })));
        return;
      }

      if (sub === "stats" && !group) {
        const auth = await requireTicketPermission(ctx, "can_view_stats");
        if (!auth) return;
        const memberOpt = interaction.options.getUser("member");
        const days = interaction.options.getInteger("days");
        await interaction.deferReply({ ephemeral: ctx.ephemeral });
        const summary = await getTicketHandlerStats(guildId, {
          sinceMs: days ? Date.now() - days * 86_400_000 : undefined,
          staffId: memberOpt?.id,
        });

        const fmt = (ms: number | null) => (ms == null ? "n/a" : formatDurationShort(ms));
        const windowLabel = days ? `last ${days} day${days === 1 ? "" : "s"}` : "all time";

        if (memberOpt) {
          const stat = summary.handlers[0] as TicketHandlerStat | undefined;
          if (!stat) {
            await interaction.editReply(resultEdit("No data", `No ticket activity for ${memberOpt.tag} (${windowLabel}).`, slashResultOptions(ctx, { tone: "warning" })));
            return;
          }
          const lines = [
            `**Active assigned:** ${stat.activeAssigned}`,
            `**Closed:** ${stat.ticketsClosed} (avg resolution ${fmt(stat.avgResolutionMs)})`,
            `**First responses:** ${stat.ticketsResponded} (avg response time ${fmt(stat.avgFirstResponseMs)})`,
          ];
          await interaction.editReply(
            resultEdit(`Ticket stats: ${memberOpt.tag} (${windowLabel})`, lines.join("\n"), slashResultOptions(ctx, { emoji: "<:icons_summary:1544418222831571044>" })),
          );
          return;
        }

        const top = summary.handlers.slice(0, 10);
        const lines = [
          `**Overall (${windowLabel}):** ${summary.overall.ticketsClosed} closed, avg resolution ${fmt(summary.overall.avgResolutionMs)} · ${summary.overall.ticketsResponded} first responses, avg response time ${fmt(summary.overall.avgFirstResponseMs)}`,
          "",
          top.length ? "**By handler:**" : "No handler activity yet.",
          ...top.map(
            (h, i) =>
              `${i + 1}. <@${h.staffId}>: ${h.ticketsClosed} closed (avg ${fmt(h.avgResolutionMs)}), ${h.ticketsResponded} first responses (avg ${fmt(h.avgFirstResponseMs)}), ${h.activeAssigned} active`,
          ),
        ];
        await interaction.editReply(
          resultEdit("Ticket handler stats", lines.join("\n"), slashResultOptions(ctx, { emoji: "<:icons_summary:1544418222831571044>" })),
        );
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
          await interaction.reply(resultReply("Ticket claimed", `You are now handling ticket #${ticket.number}.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_hammer:1544417299937763348>" })));
        } else {
          await performUnclaim(ticket);
          await interaction.reply(resultReply("Ticket unclaimed", `Ticket #${ticket.number} is now unclaimed.`, ctx.ephemeral, slashResultOptions(ctx, { emoji: "<:icons_unlock:1544417749617610852>" })));
        }
        return;
      }

      if (sub === "assign" || sub === "unassign") {
        const auth = await requireTicketPermission(ctx, "can_assign");
        if (!auth) return;
        if (sub === "assign") {
          const target = interaction.options.getUser("user", true);
          await performAssign(ctx.client, ctx.guildConfig, auth.pluginConfig, ticket, target.id, interaction.user.id);
          await interaction.reply(
            resultReply("Ticket assigned", `${target.tag} is now handling ticket #${ticket.number}.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_hammer:1544417299937763348>" })),
          );
        } else {
          await performUnassign(ctx.client, ctx.guildConfig, auth.pluginConfig, ticket, interaction.user.id);
          await interaction.reply(resultReply("Ticket unassigned", `Ticket #${ticket.number} is now unassigned.`, ctx.ephemeral, slashResultOptions(ctx, { emoji: "<:icons_unlock:1544417749617610852>" })));
        }
        return;
      }

      if (group === "status" && sub === "set") {
        const auth = await requireTicketPermission(ctx, "can_set_status");
        if (!auth) return;
        const status = interaction.options.getString("status", true) as TicketStatus;
        await performSetStatus(ctx.client, ctx.guildConfig, auth.pluginConfig, ticket, status, interaction.user.id);
        await interaction.reply(
          resultReply("Status updated", `Ticket #${ticket.number} is now **${TICKET_STATUS_LABELS[status]}**.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_flag:1544417544251772999>" })),
        );
        return;
      }

      if (sub === "close") {
        const pluginConfig = (await getTicketsPluginConfig(guildId, ctx.guildConfig, interaction.member as import("discord.js").GuildMember)) as TicketsConfig;
        const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
        const category = panel?.categories.find((c) => c.id === ticket.categoryId);
        const isOpener = ticket.openerId === interaction.user.id;
        const isStaff = await hasPermission(guildId, "tickets", "can_close_others", interaction.member as import("discord.js").GuildMember, ctx.guildConfig);
        const canCloseOwn = isOpener && (await hasPermission(guildId, "tickets", "can_close", interaction.member as import("discord.js").GuildMember, ctx.guildConfig));
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
        await interaction.editReply(resultEdit("Ticket closed", `Ticket #${ticket.number} has been closed.`, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_archive:1544417474823590008>" })));
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
          resultReply(
            sub === "add" ? "Member added" : "Member removed",
            `${target.tag} has been ${sub === "add" ? "added to" : "removed from"} this ticket.`,
            ctx.ephemeral,
            slashResultOptions(ctx, {
              tone: "success",
              emoji:
                sub === "add"
                  ? "<:icons_newmembers:1544417355004780769>"
                  : "<:Icons_rmembers:1544418127364751521>",
            }),
          ),
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
            ? resultReply("Renamed", `Ticket #${ticket.number} renamed.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_updatechannel:1544417815807922246>" }))
            : resultReply("Failed", "Could not rename this ticket's channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      if (sub === "priority") {
        const auth = await requireTicketPermission(ctx, "can_claim");
        if (!auth) return;
        const level = interaction.options.getString("level", true) as (typeof TICKET_PRIORITIES)[number];
        await setPriority(guildId, ticket.id, level);
        await interaction.reply(resultReply("Priority updated", `Ticket #${ticket.number} priority set to **${level}**.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success", emoji: "<:icons_flag:1544417544251772999>" })));
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
          const pluginConfig = (await getTicketsPluginConfig(guildId, ctx.guildConfig)) as TicketsConfig;
          const channelId = pluginConfig.default_transcript_channel_id;
          if (channelId) await postTranscriptLog(ctx.client, channelId, ticket, latest.id);
        }
        await interaction.editReply(
          resultEdit(
            sent ? "Transcript sent" : "Transcript posted",
            sent ? "Check your DMs for the transcript." : "Could not DM you — posted the transcript to the log channel instead.",
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_folder:1544417545602334791>" }),
          ),
        );
        return;
      }
    },
  },
];
