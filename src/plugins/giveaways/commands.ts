import { ChannelType, SlashCommandBuilder, type AutocompleteInteraction, type SlashCommandSubcommandBuilder } from "discord.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, discordTs, embedField, setEmbedAuthor } from "../../core/embeds.js";
import { createGiveawayFromInput, editGiveawayFromInput, parseDurationText, getGiveawaysConfig, LIMITS } from "./functions/create.js";
import {
  cancelGiveaway,
  endGiveawayNow,
  extendGiveaway,
  formatMinutes,
  pauseGiveaway,
  removeEntrant,
  rerollGiveaway,
  resumeGiveaway,
  type ActionResult,
} from "./functions/lifecycle.js";
import { bonusLines, messageUrl, requirementLines } from "./functions/message.js";
import { getEntryStats, getGiveaway, listCurrentWinners, listEntries, listGiveaways, type Giveaway, type GiveawayStatus } from "./functions/store.js";

const STATUS_LABEL: Record<GiveawayStatus, string> = {
  scheduled: "Scheduled",
  active: "Running",
  paused: "Paused",
  ending: "Ending",
  ended: "Ended",
  cancelled: "Cancelled",
};

const ENTRANTS_PAGE = 20;

export async function handleGiveawayAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "giveaway" || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const sub = interaction.options.getSubcommand(false);
  const query = String(focused.value ?? "").toLowerCase();
  const wanted: GiveawayStatus[] | null =
    sub === "reroll"
      ? ["ended"]
      : sub === "pause"
        ? ["active"]
        : sub === "resume"
          ? ["paused"]
          : sub === "end"
            ? ["active", "paused"]
            : sub === "edit" || sub === "extend" || sub === "cancel"
              ? ["scheduled", "active", "paused"]
              : null;
  const giveaways = await listGiveaways(interaction.guildId, wanted ? { status: wanted } : undefined);
  const choices = giveaways
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .filter((g) => !query || String(g.id) === query.replace("#", "") || g.title.toLowerCase().includes(query) || g.prize.toLowerCase().includes(query))
    .slice(0, 25)
    .map((g) => ({ name: `#${g.id} ${g.prize} (${STATUS_LABEL[g.status]})`.slice(0, 100), value: String(g.id) }));
  await interaction.respond(choices);
}

async function resolveGiveaway(ctx: SlashCommandContext): Promise<Giveaway | null> {
  const raw = ctx.interaction.options.getString("giveaway", true).replace("#", "").trim();
  const id = Number(raw);
  const giveaway = Number.isInteger(id) && id > 0 ? await getGiveaway(ctx.interaction.guildId!, id) : null;
  if (!giveaway) {
    await ctx.interaction.reply(
      resultReply(
        ctx.t("giveaways.notFoundTitle", "Giveaway not found"),
        ctx.t("giveaways.notFoundBody", "Pick a giveaway from the list as you type."),
        ctx.ephemeral,
        slashResultOptions(ctx, { tone: "error" }),
      ),
    );
    return null;
  }
  return giveaway;
}

function giveawayOption(sub: SlashCommandSubcommandBuilder) {
  return sub.addStringOption((o) => o.setName("giveaway").setDescription("The giveaway (search by prize or #id)").setRequired(true).setAutocomplete(true));
}

async function replyResult(ctx: SlashCommandContext, result: ActionResult, title: string, body: string, deferred: boolean) {
  const payload = result.ok
    ? { title, body, tone: "success" as const }
    : { title: ctx.t("giveaways.failedTitle", "Couldn't do that"), body: result.error, tone: "error" as const };
  if (deferred) {
    await ctx.interaction.editReply(resultEdit(payload.title, payload.body, slashResultOptions(ctx, { tone: payload.tone })));
  } else {
    await ctx.interaction.reply(resultReply(payload.title, payload.body, ctx.ephemeral, slashResultOptions(ctx, { tone: payload.tone })));
  }
}

function link(giveaway: Giveaway): string {
  const url = messageUrl(giveaway);
  return url ? ` [Open giveaway](${url})` : "";
}

export const giveawaysCommands: SlashCommandDefinition[] = [
  {
    plugin: "giveaways",
    data: new SlashCommandBuilder()
      .setName("giveaway")
      .setDescription("Run and manage giveaways")
      .addSubcommand((sub) =>
        sub
          .setName("start")
          .setDescription("Start a giveaway")
          .addStringOption((o) => o.setName("prize").setDescription("What the winner gets").setRequired(true).setMaxLength(LIMITS.prize))
          .addStringOption((o) => o.setName("duration").setDescription("How long it runs, like 30m, 2h, 1d12h or 1w").setRequired(true).setMaxLength(20))
          .addIntegerOption((o) => o.setName("winners").setDescription("How many winners (default from settings)").setMinValue(1).setMaxValue(LIMITS.winners))
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Where to post it (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((o) => o.setName("description").setDescription("A few words about the giveaway").setMaxLength(1000))
          .addStringOption((o) => o.setName("image").setDescription("Image or banner link (https)").setMaxLength(500))
          .addUserOption((o) => o.setName("host").setDescription("Shown as the host"))
          .addStringOption((o) => o.setName("sponsor").setDescription("Shown as the sponsor").setMaxLength(LIMITS.sponsor))
          .addRoleOption((o) => o.setName("ping").setDescription("Role to ping when it starts"))
          .addRoleOption((o) => o.setName("required_role").setDescription("Only members with this role can enter"))
          .addIntegerOption((o) => o.setName("min_account_age").setDescription("Minimum account age in days").setMinValue(0).setMaxValue(LIMITS.ageDays))
          .addIntegerOption((o) => o.setName("min_messages").setDescription("Minimum messages sent in this server").setMinValue(0).setMaxValue(LIMITS.messages))
          .addStringOption((o) =>
            o
              .setName("repeat")
              .setDescription("Start a fresh copy after it ends")
              .addChoices({ name: "Don't repeat", value: "none" }, { name: "Every day", value: "daily" }, { name: "Every week", value: "weekly" }),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List this server's giveaways")
          .addStringOption((o) =>
            o
              .setName("status")
              .setDescription("Only show these")
              .addChoices(
                { name: "Running", value: "active" },
                { name: "Scheduled", value: "scheduled" },
                { name: "Paused", value: "paused" },
                { name: "Ended", value: "ended" },
                { name: "Cancelled", value: "cancelled" },
              ),
          ),
      )
      .addSubcommand((sub) => giveawayOption(sub).setName("info").setDescription("Show a giveaway's details"))
      .addSubcommand((sub) =>
        giveawayOption(sub)
          .setName("entrants")
          .setDescription("See who entered, or remove someone")
          .addUserOption((o) => o.setName("remove").setDescription("Take this member out of the giveaway"))
          .addBooleanOption((o) => o.setName("block").setDescription("Also block them from every giveaway in this server"))
          .addIntegerOption((o) => o.setName("page").setDescription("Page of the list").setMinValue(1)),
      )
      .addSubcommand((sub) =>
        giveawayOption(sub)
          .setName("edit")
          .setDescription("Change a giveaway that hasn't ended")
          .addStringOption((o) => o.setName("prize").setDescription("New prize").setMaxLength(LIMITS.prize))
          .addStringOption((o) => o.setName("description").setDescription("New description").setMaxLength(1000))
          .addIntegerOption((o) => o.setName("winners").setDescription("New number of winners").setMinValue(1).setMaxValue(LIMITS.winners))
          .addStringOption((o) => o.setName("ends_in").setDescription("End this long from now, like 2h or 1d").setMaxLength(20))
          .addStringOption((o) => o.setName("image").setDescription("New image link (https), or 'none' to remove").setMaxLength(500))
          .addUserOption((o) => o.setName("host").setDescription("New host"))
          .addStringOption((o) => o.setName("sponsor").setDescription("New sponsor, or 'none' to remove").setMaxLength(LIMITS.sponsor)),
      )
      .addSubcommand((sub) =>
        giveawayOption(sub)
          .setName("extend")
          .setDescription("Add time to a giveaway")
          .addStringOption((o) => o.setName("by").setDescription("How much longer, like 30m, 2h or 1d").setRequired(true).setMaxLength(20)),
      )
      .addSubcommand((sub) => giveawayOption(sub).setName("end").setDescription("End a giveaway now and draw the winners"))
      .addSubcommand((sub) =>
        giveawayOption(sub)
          .setName("reroll")
          .setDescription("Draw new winners")
          .addUserOption((o) => o.setName("winner").setDescription("Only replace this winner (default: replace every winner)")),
      )
      .addSubcommand((sub) => giveawayOption(sub).setName("pause").setDescription("Pause entries and the countdown"))
      .addSubcommand((sub) => giveawayOption(sub).setName("resume").setDescription("Resume a paused giveaway"))
      .addSubcommand((sub) => giveawayOption(sub).setName("cancel").setDescription("Cancel a giveaway without drawing winners")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const guild = ctx.interaction.guild!;
      const t = ctx.t;

      if (sub === "start") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_start");
        if (!auth) return;
        const durationMs = parseDurationText(ctx.interaction.options.getString("duration", true));
        if (!durationMs) {
          await replyResult(ctx, { ok: false, error: t("giveaways.badDuration", "Write the duration like 30m, 2h, 1d12h or 1w.") }, "", "", false);
          return;
        }
        await ctx.interaction.deferReply({ ephemeral: true });
        const config = await getGiveawaysConfig(guildId);
        const description = ctx.interaction.options.getString("description") ?? "";
        const image = ctx.interaction.options.getString("image") ?? "";
        const requiredRole = ctx.interaction.options.getRole("required_role");
        const result = await createGiveawayFromInput(guild, auth.member.id, {
          channelId: ctx.interaction.options.getChannel("channel")?.id ?? (config.default_channel_id || ctx.interaction.channelId),
          prize: ctx.interaction.options.getString("prize", true),
          durationMinutes: Math.max(1, Math.round(durationMs / 60_000)),
          winnerCount: ctx.interaction.options.getInteger("winners") ?? undefined,
          embed: { ...config.default_embed, enabled: true, ...(description ? { description } : {}), ...(image ? { image_url: image } : {}) },
          hostId: (ctx.interaction.options.getUser("host") ?? ctx.interaction.user).id,
          sponsor: ctx.interaction.options.getString("sponsor") ?? undefined,
          pingRoleId: ctx.interaction.options.getRole("ping")?.id,
          requireRoleIds: requiredRole ? [requiredRole.id] : undefined,
          minAccountAgeDays: ctx.interaction.options.getInteger("min_account_age") ?? undefined,
          minMessages: ctx.interaction.options.getInteger("min_messages") ?? undefined,
          recurrence: (ctx.interaction.options.getString("repeat") as "none" | "daily" | "weekly" | null) ?? undefined,
        });
        if ("error" in result) {
          await replyResult(ctx, { ok: false, error: result.error }, "", "", true);
          return;
        }
        const g = result.giveaway;
        await replyResult(
          ctx,
          { ok: true, giveaway: g },
          t("giveaways.startedTitle", "Giveaway started"),
          g.messageId
            ? t("giveaways.startedBody", "**{prize}** is live in <#{channel}> and ends {ends}.", { prize: g.prize, channel: g.channelId, ends: discordTs(g.endsAt) }) + link(g)
            : g.lastError ?? t("giveaways.startedPending", "It's saved and will post as soon as Dreamliner can."),
          true,
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_view_all");
        if (!auth) return;
        const status = ctx.interaction.options.getString("status") as GiveawayStatus | null;
        const giveaways = (await listGiveaways(guildId, status ? { status } : undefined)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const lines = giveaways.slice(0, 20).map((g) => {
          const when = g.status === "ended" ? `ended ${discordTs(g.endedAt ?? g.endsAt)}` : g.status === "scheduled" ? `starts ${discordTs(g.startsAt)}` : g.status === "cancelled" ? "cancelled" : `ends ${discordTs(g.endsAt)}`;
          return `**#${g.id}** ${g.prize} - ${STATUS_LABEL[g.status]}, ${when}`;
        });
        const embed = setEmbedAuthor(baseEmbed(), t("giveaways.listTitle", "Giveaways"), ctx.client, commandHeader(ctx.guildConfig));
        embed.setDescription(
          lines.length
            ? `${lines.join("\n")}${giveaways.length > 20 ? `\n-# ${t("giveaways.listMore", "And {count} more on the dashboard.", { count: giveaways.length - 20 })}` : ""}`.slice(0, 4000)
            : t("giveaways.noneYet", "No giveaways yet. Start one with /giveaway start or from the dashboard."),
        );
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "info") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_view_all");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        const [stats, winners] = await Promise.all([getEntryStats(g.id), listCurrentWinners(g.id)]);
        const embed = setEmbedAuthor(baseEmbed(), `${t("giveaways.infoTitlePrefix", "Giveaway")} #${g.id}`, ctx.client, commandHeader(ctx.guildConfig));
        embed.addFields(
          embedField(t("giveaways.field.prize", "Prize"), g.prize, true),
          embedField(t("giveaways.field.status", "Status"), STATUS_LABEL[g.status], true),
          embedField(t("giveaways.field.channel", "Channel"), `<#${g.channelId}>`, true),
          embedField(t("giveaways.field.entries", "Entries"), `${stats.entrants.toLocaleString("en-US")} (${stats.bonusEntrants.toLocaleString("en-US")} with bonus)`, true),
          embedField(t("giveaways.field.winners", "Winners"), String(g.winnerCount), true),
          embedField(g.status === "scheduled" ? t("giveaways.field.starts", "Starts") : t("giveaways.field.ends", "Ends"), discordTs(g.status === "scheduled" ? g.startsAt : (g.endedAt ?? g.endsAt)), true),
        );
        const reqs = requirementLines(g);
        if (reqs.length) embed.addFields(embedField(t("giveaways.field.requirements", "Requirements"), reqs.map((l) => `- ${l}`).join("\n")));
        const bonus = bonusLines(g);
        if (bonus.length) embed.addFields(embedField(t("giveaways.field.bonus", "Bonus entries"), bonus.map((l) => `- ${l}`).join("\n")));
        if (winners.length) embed.addFields(embedField(t("giveaways.field.winnerList", "Current winners"), winners.map((w) => `<@${w.userId}>${w.status === "claimed" ? " (claimed)" : ""}`).join(", ")));
        if (g.lastError) embed.addFields(embedField(t("giveaways.field.problem", "Problem"), g.lastError));
        const url = messageUrl(g);
        if (url) embed.addFields(embedField(t("giveaways.field.link", "Message"), `[Open in Discord](${url})`));
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "entrants") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_manage_entrants");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        const target = ctx.interaction.options.getUser("remove");
        if (target) {
          const block = ctx.interaction.options.getBoolean("block") ?? false;
          const result = await removeEntrant(guild, g, target.id, { blacklist: block, actorId: auth.member.id });
          await replyResult(
            ctx,
            result,
            t("giveaways.entrantRemovedTitle", "Entrant removed"),
            block
              ? t("giveaways.entrantBlockedBody", "<@{user}> is out of this giveaway and blocked from every giveaway in this server.", { user: target.id })
              : t("giveaways.entrantRemovedBody", "<@{user}> is no longer entered.", { user: target.id }),
            false,
          );
          return;
        }
        const entries = (await listEntries(g.id)).sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime());
        const pages = Math.max(1, Math.ceil(entries.length / ENTRANTS_PAGE));
        const page = Math.min(pages, ctx.interaction.options.getInteger("page") ?? 1);
        const slice = entries.slice((page - 1) * ENTRANTS_PAGE, page * ENTRANTS_PAGE);
        const embed = setEmbedAuthor(baseEmbed(), `${t("giveaways.entrantsTitle", "Entrants")}: ${g.prize}`.slice(0, 200), ctx.client, commandHeader(ctx.guildConfig));
        embed.setDescription(
          slice.length
            ? [
                ...slice.map((e) => `<@${e.userId}>${e.weight !== 1 ? ` x${e.weight}` : ""} - ${discordTs(e.enteredAt)}`),
                `-# ${t("giveaways.entrantsPage", "Page {page} of {pages}, {count} entrants", { page, pages, count: entries.length.toLocaleString("en-US") })}`,
              ].join("\n")
            : t("giveaways.noEntrants", "Nobody has entered yet."),
        );
        await ctx.interaction.reply({ ...embedReply(embed, true), allowedMentions: { parse: [] } });
        return;
      }

      if (sub === "edit") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_edit");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        const o = ctx.interaction.options;
        const endsIn = o.getString("ends_in");
        const endsMs = endsIn ? parseDurationText(endsIn) : null;
        if (endsIn && !endsMs) {
          await replyResult(ctx, { ok: false, error: t("giveaways.badDuration", "Write the duration like 30m, 2h, 1d12h or 1w.") }, "", "", false);
          return;
        }
        const description = o.getString("description");
        const image = o.getString("image");
        const sponsor = o.getString("sponsor");
        const embed =
          description !== null || image !== null
            ? {
                ...g.embedConfig,
                ...(description !== null ? { description } : {}),
                ...(image !== null ? { image_url: image.trim().toLowerCase() === "none" ? "" : image } : {}),
              }
            : undefined;
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await editGiveawayFromInput(
          guild,
          g,
          {
            ...(o.getString("prize") !== null ? { prize: o.getString("prize")! } : {}),
            ...(o.getInteger("winners") !== null ? { winnerCount: o.getInteger("winners")! } : {}),
            ...(endsMs ? { endsAt: new Date(Date.now() + endsMs).toISOString() } : {}),
            ...(embed ? { embed } : {}),
            ...(o.getUser("host") ? { hostId: o.getUser("host")!.id } : {}),
            ...(sponsor !== null ? { sponsor: sponsor.trim().toLowerCase() === "none" ? "" : sponsor } : {}),
          },
          auth.member.id,
        );
        await replyResult(
          ctx,
          "error" in result ? { ok: false, error: result.error } : { ok: true, giveaway: result.giveaway },
          t("giveaways.editedTitle", "Giveaway updated"),
          "error" in result ? "" : t("giveaways.editedBody", "Your changes are live.") + link(result.giveaway),
          true,
        );
        return;
      }

      if (sub === "extend") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_edit");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        const ms = parseDurationText(ctx.interaction.options.getString("by", true));
        if (!ms) {
          await replyResult(ctx, { ok: false, error: t("giveaways.badDuration", "Write the duration like 30m, 2h, 1d12h or 1w.") }, "", "", false);
          return;
        }
        const minutes = Math.max(1, Math.round(ms / 60_000));
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await extendGiveaway(guild, g, minutes, auth.member.id);
        await replyResult(
          ctx,
          result,
          t("giveaways.extendedTitle", "Giveaway extended"),
          result.ok ? t("giveaways.extendedBody", "Added {time}. It now ends {ends}.", { time: formatMinutes(minutes), ends: discordTs(result.giveaway.endsAt) }) : "",
          true,
        );
        return;
      }

      if (sub === "end") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_end");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await endGiveawayNow(ctx.client, g, auth.member.id);
        const winners = result.ok ? await listCurrentWinners(g.id) : [];
        await replyResult(
          ctx,
          result,
          t("giveaways.endedTitle", "Giveaway ended"),
          winners.length
            ? t("giveaways.endedBody", "Winners: {winners}", { winners: winners.map((w) => `<@${w.userId}>`).join(", ") })
            : t("giveaways.endedNoWinners", "Nobody who entered could win, so there's no winner."),
          true,
        );
        return;
      }

      if (sub === "reroll") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_reroll");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        const winner = ctx.interaction.options.getUser("winner");
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await rerollGiveaway(ctx.client, g, winner ? [winner.id] : null, auth.member.id);
        const newIds = result.ok ? (result.result?.newWinnerIds ?? []) : [];
        await replyResult(
          ctx,
          result,
          t("giveaways.rerolledTitle", "Rerolled"),
          newIds.length
            ? t("giveaways.rerolledBody", "New winner(s): {winners}", { winners: newIds.map((id) => `<@${id}>`).join(", ") })
            : t("giveaways.rerolledNoneBody", "Nobody else was left to draw from."),
          true,
        );
        return;
      }

      if (sub === "pause" || sub === "resume") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_pause");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = sub === "pause" ? await pauseGiveaway(guild, g, auth.member.id) : await resumeGiveaway(guild, g, auth.member.id);
        await replyResult(
          ctx,
          result,
          sub === "pause" ? t("giveaways.pausedTitle", "Paused") : t("giveaways.resumedTitle", "Resumed"),
          result.ok
            ? sub === "pause"
              ? t("giveaways.pausedBody", "Entries and the countdown are on hold until you resume it.")
              : t("giveaways.resumedBody", "Entries are open again. It now ends {ends}.", { ends: discordTs(result.giveaway.endsAt) })
            : "",
          true,
        );
        return;
      }

      if (sub === "cancel") {
        const auth = await requirePluginPermission(ctx, "giveaways", "can_cancel");
        if (!auth) return;
        const g = await resolveGiveaway(ctx);
        if (!g) return;
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await cancelGiveaway(guild, g, auth.member.id);
        await replyResult(ctx, result, t("giveaways.cancelledTitle", "Cancelled"), t("giveaways.cancelledBody", "The giveaway was cancelled. Nobody won, and any entry costs were refunded."), true);
      }
    },
  },
];
