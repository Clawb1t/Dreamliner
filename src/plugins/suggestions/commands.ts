import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import {
  SUGGESTION_DISPLAY_STATUSES,
  zSuggestionsConfig,
  type SuggestionDisplayStatus,
} from "../../config/schemas/suggestions.js";
import { checkFeedbackEligibility } from "../feedback/eligibility.js";
import { parseDuration } from "../infraction/functions/duration.js";
import { DISPLAY_STATUS_LABELS } from "./constants.js";
import { buildSuggestModal } from "./functions/modal.js";
import {
  addSuggestionComment,
  approveSuggestion,
  deleteSuggestion,
  denySuggestion,
  markSuggestion,
} from "./functions/service.js";
import {
  blockUser,
  countComments,
  followSuggestion,
  getLastSuggestionAt,
  getSuggestionByNumber,
  getVoteTotals,
  isBlocked,
  listBlocks,
  listComments,
  listFollowedByUser,
  listSuggestions,
  topSuggestions,
  unblockUser,
  unfollowSuggestion,
} from "./functions/store.js";
import { buildSuggestionEmbed, displayStatusLabel, formatCommentsList } from "./functions/embeds.js";

function parseIds(raw: string): number[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
}

export const suggestionsCommands: SlashCommandDefinition[] = [
  {
    plugin: "suggestions",
    data: new SlashCommandBuilder()
      .setName("suggest")
      .setDescription("Submit a suggestion")
      .addBooleanOption((o) =>
        o.setName("anonymous").setDescription("Submit anonymously (if enabled)"),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "suggestions", "can_suggest");
      if (!auth) return;
      const config = zSuggestionsConfig.parse(auth.pluginConfig);
      const anon = ctx.interaction.options.getBoolean("anonymous") ?? false;
      if (anon && !config.anonymous) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("suggestions.anonDisabledTitle", "Anonymous disabled"),
            ctx.t("suggestions.anonDisabledBody", "Anonymous suggestions are not enabled."),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }
      if (await isBlocked(ctx.interaction.guildId!, auth.member.id)) {
        await ctx.interaction.reply(
          resultReply(ctx.t("suggestions.blockedTitle", "Blocked"), ctx.t("suggestions.blockedBody", "You are blocked from suggesting."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }
      const lastAt = await getLastSuggestionAt(ctx.interaction.guildId!, auth.member.id);
      const eligibility = await checkFeedbackEligibility({
        member: auth.member,
        channelId: ctx.interaction.channelId,
        config: {
          min_messages: config.min_messages,
          min_account_age: config.min_account_age,
          min_member_age: config.min_member_age,
          cooldown: config.cooldown,
          allowed_roles: config.allowed_suggest_roles,
          blocked_roles: config.blocked_suggest_roles,
          ignored_channels: config.ignored_channels,
          command_channels: config.command_channels,
        },
        lastActionAt: lastAt,
      });
      if (!eligibility.ok) {
        await ctx.interaction.reply(
          resultReply(ctx.t("suggestions.notEligibleTitle", "Not eligible"), eligibility.message, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
        );
        return;
      }
      await ctx.interaction.showModal(buildSuggestModal(anon, ctx.t));
    },
  },
  {
    plugin: "suggestions",
    data: new SlashCommandBuilder()
      .setName("suggestion")
      .setDescription("Manage and view suggestions")
      .addSubcommand((sub) =>
        sub
          .setName("info")
          .setDescription("Show suggestion details")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("top")
          .setDescription("Top voted suggestions")
          .addStringOption((o) =>
            o
              .setName("sort")
              .setDescription("Sort direction")
              .addChoices({ name: "Top", value: "top" }, { name: "Bottom", value: "bottom" }),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("follow")
          .setDescription("Follow suggestions for updates")
          .addSubcommand((sub) =>
            sub
              .setName("add")
              .setDescription("Follow a suggestion")
              .addIntegerOption((o) =>
                o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Unfollow a suggestion")
              .addIntegerOption((o) =>
                o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
              ),
          )
          .addSubcommand((sub) => sub.setName("list").setDescription("List suggestions you follow")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("approve")
          .setDescription("Approve a suggestion in the queue")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("deny")
          .setDescription("Deny a suggestion")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          )
          .addStringOption((o) => o.setName("reason").setDescription("Denial reason")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("silentdeny")
          .setDescription("Deny without denied feed/DM")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          )
          .addStringOption((o) => o.setName("reason").setDescription("Internal reason")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("dupe")
          .setDescription("Deny as duplicate of another suggestion")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion to deny").setRequired(true).setMinValue(1),
          )
          .addIntegerOption((o) =>
            o.setName("of").setDescription("Original suggestion number").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("mark")
          .setDescription("Mark an approved suggestion's status")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          )
          .addStringOption((o) =>
            o
              .setName("status")
              .setDescription("Display status")
              .setRequired(true)
              .addChoices(
                ...SUGGESTION_DISPLAY_STATUSES.map((value) => ({
                  name: DISPLAY_STATUS_LABELS[value] ?? value,
                  value,
                })),
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("comment")
          .setDescription("Add a comment to a suggestion")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          )
          .addStringOption((o) =>
            o.setName("text").setDescription("Your comment").setRequired(true).setMaxLength(1000),
          )
          .addBooleanOption((o) =>
            o.setName("anonymous").setDescription("Post anonymously (if enabled)"),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a suggestion from Discord feeds")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("silentdelete")
          .setDescription("Delete without notifying the author")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName("queue").setDescription("List suggestions awaiting review"))
      .addSubcommand((sub) =>
        sub
          .setName("search")
          .setDescription("Search suggestions")
          .addStringOption((o) => o.setName("query").setDescription("Text, number, or user ID"))
          .addStringOption((o) =>
            o
              .setName("status")
              .setDescription("Filter by status")
              .addChoices(
                { name: "Awaiting review", value: "awaiting_review" },
                { name: "Approved", value: "approved" },
                { name: "Denied", value: "denied" },
              ),
          )
          .addUserOption((o) => o.setName("author").setDescription("Filter by author")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("block")
          .setDescription("Block a user from suggesting")
          .addUserOption((o) => o.setName("user").setDescription("User to block").setRequired(true))
          .addStringOption((o) => o.setName("reason").setDescription("Reason"))
          .addStringOption((o) =>
            o.setName("duration").setDescription("Optional duration like 7d (empty = permanent)"),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("unblock")
          .setDescription("Unblock a user")
          .addUserOption((o) => o.setName("user").setDescription("User to unblock").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("blocklist").setDescription("List blocked users"))
      .addSubcommand((sub) =>
        sub
          .setName("massapprove")
          .setDescription("Approve multiple queue suggestions by number")
          .addStringOption((o) =>
            o.setName("ids").setDescription("Space/comma separated suggestion numbers").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("massdeny")
          .setDescription("Deny multiple suggestions by number")
          .addStringOption((o) =>
            o.setName("ids").setDescription("Space/comma separated suggestion numbers").setRequired(true),
          )
          .addStringOption((o) => o.setName("reason").setDescription("Shared reason")),
      ),
    execute: async (ctx) => {
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const guild = ctx.interaction.guild!;

      if (group === "follow") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_follow");
        if (!auth) return;
        if (sub === "list") {
          const followed = await listFollowedByUser(auth.member.id, guildId);
          const lines =
            followed.length === 0
              ? [ctx.t("suggestions.notFollowingAny", "You are not following any suggestions.")]
              : followed.map((s) => `**#${s.suggestionNumber}** — ${s.content.slice(0, 80)}`);
          const embed = setEmbedAuthor(baseEmbed(), ctx.t("suggestions.followedTitle", "Followed suggestions"), ctx.client, commandHeader(ctx.guildConfig));
          embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
          await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
          return;
        }
        const num = ctx.interaction.options.getInteger("id", true);
        const suggestion = await getSuggestionByNumber(guildId, num);
        if (!suggestion) {
          await ctx.interaction.reply(
            resultReply(ctx.t("suggestions.notFoundTitle", "Not found"), ctx.t("suggestions.notFoundBody", "Suggestion #{num} was not found.", { num }), ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        if (sub === "add") {
          await followSuggestion(suggestion.id, auth.member.id);
          await ctx.interaction.reply(
            resultReply(
              ctx.t("suggestions.followingTitle", "Following"),
              ctx.t("suggestions.nowFollowingBody", "You are now following #{num}.", { num }),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "success", emoji: "<:icons_notify:1544417566708211753>" }),
            ),
          );
          return;
        }
        await unfollowSuggestion(suggestion.id, auth.member.id);
        await ctx.interaction.reply(
          resultReply(ctx.t("suggestions.unfollowedTitle", "Unfollowed"), ctx.t("suggestions.unfollowedBody", "You unfollowed #{num}.", { num }), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "info") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_info");
        if (!auth) return;
        const config = zSuggestionsConfig.parse(auth.pluginConfig);
        const num = ctx.interaction.options.getInteger("id", true);
        const suggestion = await getSuggestionByNumber(guildId, num);
        if (!suggestion) {
          await ctx.interaction.reply(
            resultReply(ctx.t("suggestions.notFoundTitle", "Not found"), ctx.t("suggestions.notFoundBody", "Suggestion #{num} was not found.", { num }), ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const votes = await getVoteTotals(suggestion.id);
        const comments = await listComments(suggestion.id, 10);
        const commentCount = await countComments(suggestion.id);
        const embed = buildSuggestionEmbed({
          client: ctx.interaction.client,
          suggestion,
          config,
          votes,
          commentCount,
        });
        if (suggestion.anonymous) {
          embed.addFields(embedField(ctx.t("suggestions.authorStaffLabel", "Author (staff)"), `<@${suggestion.authorId}>`, true));
        }
        if (comments.length) {
          embed.addFields(
            embedField(
              ctx.t("suggestions.field.recentComments", "Recent comments"),
              formatCommentsList(comments, ctx.t).slice(0, 1000),
            ),
          );
        }
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "top") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_top");
        if (!auth) return;
        const sort = (ctx.interaction.options.getString("sort") ?? "top") as "top" | "bottom";
        const rows = await topSuggestions(guildId, sort, 10);
        const lines =
          rows.length === 0
            ? [ctx.t("suggestions.noApprovedYet", "No approved suggestions yet.")]
            : rows.map(
                (s) =>
                  `**#${s.suggestionNumber}** net ${s.net} (▲${s.up}/▼${s.down}) — ${s.content.slice(0, 70)}`,
              );
        const embed = setEmbedAuthor(
          baseEmbed(),
          sort === "top" ? ctx.t("suggestions.topTitle", "Top suggestions") : ctx.t("suggestions.lowestTitle", "Lowest suggestions"),
          ctx.client,
          commandHeader(ctx.guildConfig, sort === "top" ? { emoji: "<:icons_trophy:1544418249721126922>" } : undefined),
        );
        embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "queue" || sub === "search") {
        const auth = await requirePluginPermission(ctx, "suggestions", sub === "queue" ? "can_manage" : "can_info");
        if (!auth) return;
        const result = await listSuggestions(guildId, {
          status: sub === "queue" ? "awaiting_review" : (ctx.interaction.options.getString("status") as "awaiting_review" | "approved" | "denied" | null),
          authorId: ctx.interaction.options.getUser("author")?.id ?? null,
          q: ctx.interaction.options.getString("query") ?? undefined,
          limit: 20,
          offset: 0,
        });
        const lines =
          result.suggestions.length === 0
            ? [ctx.t("suggestions.noneFound", "No suggestions found.")]
            : result.suggestions.map(
                (s) =>
                  `**#${s.suggestionNumber}** [${s.status}] ${s.anonymous ? ctx.t("suggestions.anonymous", "Anonymous") : `<@${s.authorId}>`} — ${s.content.slice(0, 70)}`,
              );
        const embed = setEmbedAuthor(
          baseEmbed(),
          sub === "queue" ? ctx.t("suggestions.queueTitle", "Suggestion queue") : ctx.t("suggestions.searchTitle", "Suggestion search"),
          ctx.client,
          commandHeader(ctx.guildConfig, sub === "queue" ? { emoji: "<:icons_queue:1544417738410164224>" } : undefined),
        );
        embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
        embed.addFields(embedField(ctx.t("suggestions.totalLabel", "Total"), String(result.total), true));
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "approve" || sub === "deny" || sub === "silentdeny" || sub === "dupe") {
        const perm = sub === "approve" ? "can_approve" : "can_deny";
        const auth = await requirePluginPermission(ctx, "suggestions", perm);
        if (!auth) return;
        const config = zSuggestionsConfig.parse(auth.pluginConfig);
        const num = ctx.interaction.options.getInteger("id", true);
        const suggestion = await getSuggestionByNumber(guildId, num);
        if (!suggestion) {
          await ctx.interaction.reply(
            resultReply(ctx.t("suggestions.notFoundTitle", "Not found"), ctx.t("suggestions.notFoundBody", "Suggestion #{num} was not found.", { num }), ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });

        if (sub === "approve") {
          const result = await approveSuggestion({
            client: ctx.interaction.client,
            guild,
            guildConfig: ctx.guildConfig,
            config,
            suggestionId: suggestion.id,
            staffId: auth.member.id,
          });
          await ctx.interaction.editReply(
            resultEdit(
              result.error ? ctx.t("suggestions.errorTitle", "Error") : ctx.t("suggestions.status.approved", "Approved"),
              result.error ?? ctx.t("suggestions.approvedNumBody", "Approved #{num}.", { num }),
              slashResultOptions(ctx, {
                tone: result.error ? "error" : "success",
                emoji: result.error ? undefined : "<:icons_upvote:1544417455689179349>",
              }),
            ),
          );
          return;
        }

        let reason = ctx.interaction.options.getString("reason");
        if (sub === "dupe") {
          const of = ctx.interaction.options.getInteger("of", true);
          reason = reason
            ? ctx.t("suggestions.duplicateOfWithReason", "Duplicate of #{of} — {reason}", { of, reason })
            : ctx.t("suggestions.duplicateOf", "Duplicate of #{of}", { of });
        }

        const result = await denySuggestion({
          client: ctx.interaction.client,
          guild,
          guildConfig: ctx.guildConfig,
          config,
          suggestionId: suggestion.id,
          staffId: auth.member.id,
          reason,
          silent: sub === "silentdeny",
        });
        await ctx.interaction.editReply(
          resultEdit(
            result.error ? ctx.t("suggestions.errorTitle", "Error") : ctx.t("suggestions.status.denied", "Denied"),
            result.error ?? ctx.t("suggestions.deniedNumBody", "Denied #{num}.", { num }),
            slashResultOptions(ctx, {
              tone: result.error ? "error" : "success",
              emoji: result.error ? undefined : "<:icons_downvote:1544417248209404054>",
            }),
          ),
        );
        return;
      }

      if (sub === "mark") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_mark");
        if (!auth) return;
        const config = zSuggestionsConfig.parse(auth.pluginConfig);
        const num = ctx.interaction.options.getInteger("id", true);
        const suggestion = await getSuggestionByNumber(guildId, num);
        if (!suggestion) {
          await ctx.interaction.reply(
            resultReply(ctx.t("suggestions.notFoundTitle", "Not found"), ctx.t("suggestions.notFoundBody", "Suggestion #{num} was not found.", { num }), ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const status = ctx.interaction.options.getString("status", true) as SuggestionDisplayStatus;
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await markSuggestion({
          client: ctx.interaction.client,
          guild,
          config,
          suggestionId: suggestion.id,
          staffId: auth.member.id,
          displayStatus: status,
        });
        await ctx.interaction.editReply(
          resultEdit(
            result.error ? ctx.t("suggestions.errorTitle", "Error") : ctx.t("suggestions.markedTitle", "Marked"),
            result.error ?? ctx.t("suggestions.markedNumBody", "Marked #{num} as **{status}**.", { num, status: displayStatusLabel(ctx.t, status) }),
            slashResultOptions(ctx, {
              tone: result.error ? "error" : "success",
              emoji: result.error ? undefined : "<:icons_flag:1544417544251772999>",
            }),
          ),
        );
        return;
      }

      if (sub === "comment") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_comment");
        if (!auth) return;
        const config = zSuggestionsConfig.parse(auth.pluginConfig);
        const num = ctx.interaction.options.getInteger("id", true);
        const text = ctx.interaction.options.getString("text", true);
        const anonymous = ctx.interaction.options.getBoolean("anonymous") ?? false;
        const suggestion = await getSuggestionByNumber(guildId, num);
        if (!suggestion) {
          await ctx.interaction.reply(
            resultReply(ctx.t("suggestions.notFoundTitle", "Not found"), ctx.t("suggestions.notFoundBody", "Suggestion #{num} was not found.", { num }), ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await addSuggestionComment({
          client: ctx.interaction.client,
          guild,
          guildConfig: ctx.guildConfig,
          config,
          suggestionId: suggestion.id,
          authorId: auth.member.id,
          authorName: auth.member.user.username,
          authorAvatarUrl: auth.member.user.displayAvatarURL({ size: 128 }),
          content: text,
          anonymous,
        });
        await ctx.interaction.editReply(
          resultEdit(
            "error" in result ? ctx.t("suggestions.errorTitle", "Error") : ctx.t("suggestions.commentAddedTitle", "Comment added"),
            "error" in result ? result.error : ctx.t("suggestions.commentAddedBody", "Added your comment to #{num}.", { num }),
            slashResultOptions(ctx, {
              tone: "error" in result ? "error" : "success",
              emoji: "error" in result ? undefined : "<:icons_message:1544417564447350804>",
            }),
          ),
        );
        return;
      }

      if (sub === "delete" || sub === "silentdelete") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_delete");
        if (!auth) return;
        const config = zSuggestionsConfig.parse(auth.pluginConfig);
        const num = ctx.interaction.options.getInteger("id", true);
        const suggestion = await getSuggestionByNumber(guildId, num);
        if (!suggestion) {
          await ctx.interaction.reply(
            resultReply(ctx.t("suggestions.notFoundTitle", "Not found"), ctx.t("suggestions.notFoundBody", "Suggestion #{num} was not found.", { num }), ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        const result = await deleteSuggestion({
          client: ctx.interaction.client,
          guild,
          config,
          suggestionId: suggestion.id,
          staffId: auth.member.id,
          silent: sub === "silentdelete",
        });
        await ctx.interaction.editReply(
          resultEdit(
            result.error ? ctx.t("suggestions.errorTitle", "Error") : ctx.t("suggestions.deletedLabel", "Deleted"),
            result.error ?? ctx.t("suggestions.deletedNumBody", "Deleted #{num}.", { num }),
            slashResultOptions(ctx, { tone: result.error ? "error" : "success" }),
          ),
        );
        return;
      }

      if (sub === "block" || sub === "unblock" || sub === "blocklist") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_block");
        if (!auth) return;
        if (sub === "blocklist") {
          const blocks = await listBlocks(guildId);
          const lines =
            blocks.length === 0
              ? [ctx.t("suggestions.noBlockedUsers", "No blocked users.")]
              : blocks.map((b) => {
                  const until = b.expiresAt
                    ? `<t:${Math.floor(b.expiresAt.getTime() / 1000)}:R>`
                    : ctx.t("suggestions.permanent", "permanent");
                  return `<@${b.userId}> — ${until}${b.reason ? ` — ${b.reason}` : ""}`;
                });
          const embed = setEmbedAuthor(baseEmbed(), ctx.t("suggestions.blocklistTitle", "Suggestion blocklist"), ctx.client, commandHeader(ctx.guildConfig));
          embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
          await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
          return;
        }
        const user = ctx.interaction.options.getUser("user", true);
        if (sub === "unblock") {
          const ok = await unblockUser(guildId, user.id);
          await ctx.interaction.reply(
            resultReply(
              ok ? ctx.t("suggestions.unblockedTitle", "Unblocked") : ctx.t("suggestions.notBlockedTitle", "Not blocked"),
              ok
                ? ctx.t("suggestions.unblockedBody", "Unblocked <@{id}>.", { id: user.id })
                : ctx.t("suggestions.wasNotBlockedBody", "<@{id}> was not blocked.", { id: user.id }),
              ctx.ephemeral,
              slashResultOptions(ctx, ok ? { emoji: "<:icons_unlock:1544417749617610852>" } : undefined),
            ),
          );
          return;
        }
        const durationRaw = ctx.interaction.options.getString("duration");
        let expiresAt: Date | null = null;
        if (durationRaw?.trim()) {
          const ms = parseDuration(durationRaw.trim());
          if (ms == null) {
            await ctx.interaction.reply(
              resultReply(ctx.t("suggestions.invalidDurationTitle", "Invalid duration"), ctx.t("suggestions.invalidDurationBody", "Use a duration like `7d` or `24h`."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
          expiresAt = new Date(Date.now() + ms);
        }
        await blockUser({
          guildId,
          userId: user.id,
          reason: ctx.interaction.options.getString("reason"),
          expiresAt,
          createdBy: auth.member.id,
        });
        await ctx.interaction.reply(
          resultReply(
            ctx.t("suggestions.blockedTitle", "Blocked"),
            expiresAt
              ? ctx.t("suggestions.blockedUntilBody", "Blocked <@{id}> from suggesting until <t:{ts}:f>.", {
                  id: user.id,
                  ts: Math.floor(expiresAt.getTime() / 1000),
                })
              : ctx.t("suggestions.blockedNoExpiryBody", "Blocked <@{id}> from suggesting.", { id: user.id }),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_ban:1544417486177308742>" }),
          ),
        );
        return;
      }

      if (sub === "massapprove" || sub === "massdeny") {
        const auth = await requirePluginPermission(ctx, "suggestions", "can_manage");
        if (!auth) return;
        const config = zSuggestionsConfig.parse(auth.pluginConfig);
        const ids = parseIds(ctx.interaction.options.getString("ids", true));
        if (ids.length === 0) {
          await ctx.interaction.reply(
            resultReply(ctx.t("suggestions.invalidIdsTitle", "Invalid IDs"), ctx.t("suggestions.invalidIdsBody", "Provide at least one suggestion number."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }
        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
        let ok = 0;
        let fail = 0;
        const reason = ctx.interaction.options.getString("reason");
        for (const num of ids) {
          const suggestion = await getSuggestionByNumber(guildId, num);
          if (!suggestion) {
            fail++;
            continue;
          }
          const result =
            sub === "massapprove"
              ? await approveSuggestion({
                  client: ctx.interaction.client,
                  guild,
                  guildConfig: ctx.guildConfig,
                  config,
                  suggestionId: suggestion.id,
                  staffId: auth.member.id,
                })
              : await denySuggestion({
                  client: ctx.interaction.client,
                  guild,
                  guildConfig: ctx.guildConfig,
                  config,
                  suggestionId: suggestion.id,
                  staffId: auth.member.id,
                  reason,
                });
          if (result.error) fail++;
          else ok++;
        }
        await ctx.interaction.editReply(
          resultEdit(
            ctx.t("suggestions.massActionCompleteTitle", "Mass action complete"),
            sub === "massapprove"
              ? ctx.t("suggestions.massApprovedBody", "Approved **{ok}**, failed **{fail}**.", { ok, fail })
              : ctx.t("suggestions.massDeniedBody", "Denied **{ok}**, failed **{fail}**.", { ok, fail }),
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_repeat:1544417397220311040>" }),
          ),
        );
      }
    },
  },
];
