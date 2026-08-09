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
  approveSuggestion,
  deleteSuggestion,
  denySuggestion,
  markSuggestion,
} from "./functions/service.js";
import {
  blockUser,
  followSuggestion,
  getLastSuggestionAt,
  getSuggestionByNumber,
  getVoteTotals,
  isBlocked,
  listBlocks,
  listFollowedByUser,
  listSuggestions,
  topSuggestions,
  unblockUser,
  unfollowSuggestion,
} from "./functions/store.js";
import { buildSuggestionEmbed } from "./functions/embeds.js";

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
            "Anonymous disabled",
            "Anonymous suggestions are not enabled.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }
      if (await isBlocked(ctx.interaction.guildId!, auth.member.id)) {
        await ctx.interaction.reply(
          resultReply("Blocked", "You are blocked from suggesting.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
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
          resultReply("Not eligible", eligibility.message, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
        );
        return;
      }
      await ctx.interaction.showModal(buildSuggestModal(anon));
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
              ? ["You are not following any suggestions."]
              : followed.map((s) => `**#${s.suggestionNumber}** — ${s.content.slice(0, 80)}`);
          const embed = setEmbedAuthor(baseEmbed(), "Followed suggestions", ctx.client, commandHeader(ctx.guildConfig));
          embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
          await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
          return;
        }
        const num = ctx.interaction.options.getInteger("id", true);
        const suggestion = await getSuggestionByNumber(guildId, num);
        if (!suggestion) {
          await ctx.interaction.reply(
            resultReply("Not found", `Suggestion #${num} was not found.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        if (sub === "add") {
          await followSuggestion(suggestion.id, auth.member.id);
          await ctx.interaction.reply(
            resultReply("Following", `You are now following #${num}.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "success" })),
          );
          return;
        }
        await unfollowSuggestion(suggestion.id, auth.member.id);
        await ctx.interaction.reply(
          resultReply("Unfollowed", `You unfollowed #${num}.`, ctx.ephemeral, slashResultOptions(ctx)),
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
            resultReply("Not found", `Suggestion #${num} was not found.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const votes = await getVoteTotals(suggestion.id);
        const embed = buildSuggestionEmbed({
          client: ctx.interaction.client,
          suggestion,
          config,
          votes,
        });
        if (suggestion.anonymous) {
          embed.addFields(embedField("Author (staff)", `<@${suggestion.authorId}>`, true));
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
            ? ["No approved suggestions yet."]
            : rows.map(
                (s) =>
                  `**#${s.suggestionNumber}** net ${s.net} (▲${s.up}/▼${s.down}) — ${s.content.slice(0, 70)}`,
              );
        const embed = setEmbedAuthor(
          baseEmbed(),
          sort === "top" ? "Top suggestions" : "Lowest suggestions",
          ctx.client,
          commandHeader(ctx.guildConfig),
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
            ? ["No suggestions found."]
            : result.suggestions.map(
                (s) =>
                  `**#${s.suggestionNumber}** [${s.status}] ${s.anonymous ? "Anonymous" : `<@${s.authorId}>`} — ${s.content.slice(0, 70)}`,
              );
        const embed = setEmbedAuthor(
          baseEmbed(),
          sub === "queue" ? "Suggestion queue" : "Suggestion search",
          ctx.client,
          commandHeader(ctx.guildConfig),
        );
        embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
        embed.addFields(embedField("Total", String(result.total), true));
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
            resultReply("Not found", `Suggestion #${num} was not found.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });

        if (sub === "approve") {
          const result = await approveSuggestion({
            client: ctx.interaction.client,
            guild,
            config,
            suggestionId: suggestion.id,
            staffId: auth.member.id,
          });
          await ctx.interaction.editReply(
            resultEdit(
              result.error ? "Error" : "Approved",
              result.error ?? `Approved #${num}.`,
              slashResultOptions(ctx, { tone: result.error ? "error" : "success" }),
            ),
          );
          return;
        }

        let reason = ctx.interaction.options.getString("reason");
        if (sub === "dupe") {
          const of = ctx.interaction.options.getInteger("of", true);
          reason = `Duplicate of #${of}${reason ? ` — ${reason}` : ""}`;
        }

        const result = await denySuggestion({
          client: ctx.interaction.client,
          guild,
          config,
          suggestionId: suggestion.id,
          staffId: auth.member.id,
          reason,
          silent: sub === "silentdeny",
        });
        await ctx.interaction.editReply(
          resultEdit(
            result.error ? "Error" : "Denied",
            result.error ?? `Denied #${num}.`,
            slashResultOptions(ctx, { tone: result.error ? "error" : "success" }),
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
            resultReply("Not found", `Suggestion #${num} was not found.`, ctx.ephemeral, slashResultOptions(ctx)),
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
            result.error ? "Error" : "Marked",
            result.error ?? `Marked #${num} as **${DISPLAY_STATUS_LABELS[status]}**.`,
            slashResultOptions(ctx, { tone: result.error ? "error" : "success" }),
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
            resultReply("Not found", `Suggestion #${num} was not found.`, ctx.ephemeral, slashResultOptions(ctx)),
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
            result.error ? "Error" : "Deleted",
            result.error ?? `Deleted #${num}.`,
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
              ? ["No blocked users."]
              : blocks.map((b) => {
                  const until = b.expiresAt
                    ? `<t:${Math.floor(b.expiresAt.getTime() / 1000)}:R>`
                    : "permanent";
                  return `<@${b.userId}> — ${until}${b.reason ? ` — ${b.reason}` : ""}`;
                });
          const embed = setEmbedAuthor(baseEmbed(), "Suggestion blocklist", ctx.client, commandHeader(ctx.guildConfig));
          embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
          await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
          return;
        }
        const user = ctx.interaction.options.getUser("user", true);
        if (sub === "unblock") {
          const ok = await unblockUser(guildId, user.id);
          await ctx.interaction.reply(
            resultReply(
              ok ? "Unblocked" : "Not blocked",
              ok ? `Unblocked <@${user.id}>.` : `<@${user.id}> was not blocked.`,
              ctx.ephemeral,
              slashResultOptions(ctx),
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
              resultReply("Invalid duration", "Use a duration like `7d` or `24h`.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
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
            "Blocked",
            `Blocked <@${user.id}> from suggesting${expiresAt ? ` until <t:${Math.floor(expiresAt.getTime() / 1000)}:f>` : ""}.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success" }),
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
            resultReply("Invalid IDs", "Provide at least one suggestion number.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
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
                  config,
                  suggestionId: suggestion.id,
                  staffId: auth.member.id,
                })
              : await denySuggestion({
                  client: ctx.interaction.client,
                  guild,
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
            "Mass action complete",
            `${sub === "massapprove" ? "Approved" : "Denied"} **${ok}**, failed **${fail}**.`,
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
      }
    },
  },
];
