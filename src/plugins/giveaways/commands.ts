import { SlashCommandBuilder, type AutocompleteInteraction } from "discord.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, discordTs, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { emitLog } from "../../core/logging/send.js";
import { buildClaimComponents, buildGiveawayCancelledEmbed, buildGiveawayEndedEmbed } from "./functions/embeds.js";
import { rerollWinner } from "./functions/draw.js";
import { finishGiveaway } from "./functions/scheduler.js";
import {
  claimGiveawayForEnding,
  getEntryCount,
  getGiveaway,
  listGiveaways,
  listWinnersByStatus,
  updateGiveaway,
  type Giveaway,
} from "./functions/store.js";

export async function handleGiveawayAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "giveaway" || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const query = String(focused.value ?? "").toLowerCase();
  const giveaways = await listGiveaways(interaction.guildId);
  const choices = giveaways
    .filter((g) => !query || g.title.toLowerCase().includes(query) || g.prize.toLowerCase().includes(query))
    .slice(0, 25)
    .map((g) => ({ name: `#${g.id} ${g.title} [${g.status}]`.slice(0, 100), value: String(g.id) }));
  await interaction.respond(choices);
}

async function resolveGiveaway(ctx: SlashCommandContext): Promise<Giveaway | null> {
  const raw = ctx.interaction.options.getString("giveaway", true);
  const id = Number(raw);
  if (!Number.isFinite(id)) {
    await ctx.interaction.reply(resultReply("Invalid giveaway", "That giveaway could not be resolved.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
    return null;
  }
  const giveaway = await getGiveaway(ctx.interaction.guildId!, id);
  if (!giveaway) {
    await ctx.interaction.reply(resultReply("Not found", `Giveaway #${id} was not found.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
    return null;
  }
  return giveaway;
}

function giveawayOption(sub: import("discord.js").SlashCommandSubcommandBuilder) {
  return sub.addStringOption((o) =>
    o.setName("giveaway").setDescription("The giveaway (search by title or prize)").setRequired(true).setAutocomplete(true),
  );
}

export const giveawaysCommands: SlashCommandDefinition[] = [
  {
    plugin: "giveaways",
    data: new SlashCommandBuilder()
      .setName("giveaway")
      .setDescription("View and manage giveaways")
      .addSubcommand((sub) => sub.setName("list").setDescription("List this server's giveaways"))
      .addSubcommand((sub) => giveawayOption(sub).setName("info").setDescription("Show a giveaway's details"))
      .addSubcommand((sub) =>
        giveawayOption(sub)
          .setName("reroll")
          .setDescription("Reroll a giveaway's winner(s)")
          .addUserOption((o) => o.setName("winner").setDescription("Reroll only this winner (default: reroll all)")),
      )
      .addSubcommand((sub) => giveawayOption(sub).setName("end").setDescription("End a giveaway immediately"))
      .addSubcommand((sub) => giveawayOption(sub).setName("pause").setDescription("Pause a giveaway (extends its end time by the paused duration)"))
      .addSubcommand((sub) => giveawayOption(sub).setName("resume").setDescription("Resume a paused giveaway"))
      .addSubcommand((sub) => giveawayOption(sub).setName("cancel").setDescription("Cancel a giveaway without drawing winners")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_view_all");
        if (!auth) return;
        const giveaways = await listGiveaways(guildId);
        const lines = giveaways.length
          ? giveaways
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .slice(0, 25)
              .map((g) => `**#${g.id}** [${g.status}] ${g.title} (${g.prize})`)
          : [ctx.t("giveaways.noneYet", "No giveaways yet.")];
        const embed = setEmbedAuthor(baseEmbed(), ctx.t("giveaways.listTitle", "Giveaways"), ctx.client, commandHeader(ctx.guildConfig));
        embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "info") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_view_all");
        if (!auth) return;
        const giveaway = await resolveGiveaway(ctx);
        if (!giveaway) return;
        const entryCount = await getEntryCount(giveaway.id);
        const winners = giveaway.status === "ended" ? await listWinnersByStatus(giveaway.id, "won") : [];
        const claimedWinners = giveaway.status === "ended" ? await listWinnersByStatus(giveaway.id, "claimed") : [];
        const embed = setEmbedAuthor(baseEmbed(), `${ctx.t("giveaways.infoTitlePrefix", "Giveaway")} #${giveaway.id}`, ctx.client, commandHeader(ctx.guildConfig));
        embed.addFields(
          embedField(ctx.t("giveaways.field.title", "Title"), giveaway.title, true),
          embedField(ctx.t("giveaways.field.prize", "Prize"), giveaway.prize, true),
          embedField(ctx.t("giveaways.field.status", "Status"), giveaway.status, true),
          embedField(ctx.t("giveaways.field.channel", "Channel"), `<#${giveaway.channelId}>`, true),
          embedField(ctx.t("giveaways.field.entries", "Entries"), String(entryCount), true),
          embedField(ctx.t("giveaways.field.winners", "Winner count"), String(giveaway.winnerCount), true),
          embedField(ctx.t("giveaways.field.ends", "Ends"), discordTs(giveaway.endsAt), true),
        );
        if (winners.length || claimedWinners.length) {
          const all = [...winners, ...claimedWinners];
          embed.addFields(embedField(ctx.t("giveaways.field.winnerList", "Winner(s)"), all.map((w) => `<@${w.userId}> (${w.status})`).join(", ")));
        }
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "reroll") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_reroll");
        if (!auth) return;
        const giveaway = await resolveGiveaway(ctx);
        if (!giveaway) return;
        if (giveaway.status !== "ended") {
          await ctx.interaction.reply(
            resultReply(ctx.t("giveaways.notEndedTitle", "Not ended"), ctx.t("giveaways.notEndedBody", "This giveaway hasn't ended yet, so there are no winners to reroll."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const winnerUser = ctx.interaction.options.getUser("winner");
        let winnerRowId: number | null = null;
        if (winnerUser) {
          const wonWinners = await listWinnersByStatus(giveaway.id, "won");
          const match = wonWinners.find((w) => w.userId === winnerUser.id);
          if (!match) {
            await ctx.interaction.reply(
              resultReply(ctx.t("giveaways.notWinnerTitle", "Not a current winner"), ctx.t("giveaways.notWinnerBody", "That user is not an unclaimed winner of this giveaway."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
          winnerRowId = match.id;
        }

        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await rerollWinner(giveaway, winnerRowId);
        const currentWinners = await listWinnersByStatus(giveaway.id, "won");
        const claimRowId = giveaway.claimWindowMinutes > 0 && currentWinners[0] ? currentWinners[0].id : null;
        if (giveaway.messageId) {
          const channel = await ctx.client.channels.fetch(giveaway.channelId).catch(() => null);
          if (channel?.isTextBased() && "messages" in channel) {
            const embed = buildGiveawayEndedEmbed(giveaway, currentWinners.map((w) => w.userId));
            await channel.messages
              .fetch(giveaway.messageId)
              .then((message) => message.edit({ embeds: [embed], components: claimRowId !== null ? buildClaimComponents(giveaway.id, claimRowId) : [] }))
              .catch(() => null);
          }
        }
        if (giveaway.dmWinner) {
          for (const userId of result.newWinnerIds) {
            const user = await ctx.client.users.fetch(userId).catch(() => null);
            await user?.send(ctx.t("giveaways.dm.rerollWinner", "You won **{prize}**! Congratulations.", { prize: giveaway.prize })).catch(() => null);
          }
        }
        await emitLog(
          ctx.client,
          ctx.guildConfig,
          {
            title: "Giveaway rerolled",
            information: [
              `**Prize:** ${giveaway.prize}`,
              `**By:** <@${auth.member.id}>`,
              `**New winner(s):** ${result.newWinnerIds.length ? result.newWinnerIds.map((id) => `<@${id}>`).join(", ") : "none (no eligible entrants)"}`,
            ],
            emojiCategory: "action",
          },
          {
            guildId,
            eventType: "giveaway_reroll",
            summary: `${giveaway.title || giveaway.prize} rerolled by staff.`,
            actorId: auth.member.id,
            channelId: giveaway.channelId,
            messageId: giveaway.messageId,
          },
        );
        await ctx.interaction.editReply(
          resultEdit(
            ctx.t("giveaways.rerolledTitle", "Rerolled"),
            result.newWinnerIds.length
              ? ctx.t("giveaways.rerolledBody", "New winner(s): {winners}", { winners: result.newWinnerIds.map((id) => `<@${id}>`).join(", ") })
              : ctx.t("giveaways.rerolledNoneBody", "No eligible entrants were left to draw from."),
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
        return;
      }

      if (sub === "end") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_end");
        if (!auth) return;
        const giveaway = await resolveGiveaway(ctx);
        if (!giveaway) return;
        if (giveaway.status !== "active") {
          await ctx.interaction.reply(
            resultReply(ctx.t("giveaways.cannotEndTitle", "Cannot end"), ctx.t("giveaways.cannotEndBody", "Only active giveaways can be ended now."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }
        const claimed = await claimGiveawayForEnding(giveaway.id);
        if (!claimed) {
          await ctx.interaction.reply(
            resultReply(ctx.t("giveaways.alreadyEndingTitle", "Already ending"), ctx.t("giveaways.alreadyEndingBody", "This giveaway is already being ended."), ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
          );
          return;
        }
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        await finishGiveaway(ctx.client, claimed);
        await ctx.interaction.editReply(
          resultEdit(ctx.t("giveaways.endedTitle", "Ended"), ctx.t("giveaways.endedBody", "The giveaway was ended and winners were drawn."), slashResultOptions(ctx, { tone: "success" })),
        );
        return;
      }

      if (sub === "pause" || sub === "resume") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_pause");
        if (!auth) return;
        const giveaway = await resolveGiveaway(ctx);
        if (!giveaway) return;

        if (sub === "pause") {
          if (giveaway.status !== "active") {
            await ctx.interaction.reply(
              resultReply(ctx.t("giveaways.cannotPauseTitle", "Cannot pause"), ctx.t("giveaways.cannotPauseBody", "Only active giveaways can be paused."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
          await updateGiveaway(giveaway.id, { status: "paused", pausedAt: new Date() });
          await ctx.interaction.reply(
            resultReply(ctx.t("giveaways.pausedTitle", "Paused"), ctx.t("giveaways.pausedBody", "The giveaway is paused. Entries and the countdown are frozen until it's resumed."), ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })),
          );
          return;
        }

        if (giveaway.status !== "paused" || !giveaway.pausedAt) {
          await ctx.interaction.reply(
            resultReply(ctx.t("giveaways.cannotResumeTitle", "Cannot resume"), ctx.t("giveaways.cannotResumeBody", "This giveaway isn't paused."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }
        const pausedDurationMs = Date.now() - giveaway.pausedAt.getTime();
        const newEndsAt = new Date(giveaway.endsAt.getTime() + pausedDurationMs);
        await updateGiveaway(giveaway.id, { status: "active", pausedAt: null, endsAt: newEndsAt });
        await ctx.interaction.reply(
          resultReply(ctx.t("giveaways.resumedTitle", "Resumed"), ctx.t("giveaways.resumedBody", "The giveaway resumed. It now ends {ends}.", { ends: discordTs(newEndsAt) }), ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })),
        );
        return;
      }

      if (sub === "cancel") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_cancel");
        if (!auth) return;
        const giveaway = await resolveGiveaway(ctx);
        if (!giveaway) return;
        if (giveaway.status === "ended" || giveaway.status === "cancelled") {
          await ctx.interaction.reply(
            resultReply(ctx.t("giveaways.cannotCancelTitle", "Cannot cancel"), ctx.t("giveaways.cannotCancelBody", "This giveaway has already ended or been cancelled."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }
        await updateGiveaway(giveaway.id, { status: "cancelled" });
        if (giveaway.messageId) {
          const channel = await ctx.client.channels.fetch(giveaway.channelId).catch(() => null);
          if (channel?.isTextBased() && "messages" in channel) {
            await channel.messages
              .fetch(giveaway.messageId)
              .then((message) => message.edit({ embeds: [buildGiveawayCancelledEmbed(giveaway)], components: [] }))
              .catch(() => null);
          }
        }
        await ctx.interaction.reply(
          resultReply(ctx.t("giveaways.cancelledTitle", "Cancelled"), ctx.t("giveaways.cancelledBody", "The giveaway was cancelled. No winners were drawn."), ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })),
        );
        return;
      }
    },
  },
];
