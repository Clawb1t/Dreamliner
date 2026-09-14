import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { zReviewsConfig } from "../../config/schemas/reviews.js";
import { checkFeedbackEligibility } from "../feedback/eligibility.js";
import { buildReviewModal } from "./functions/modal.js";
import {
  averageRating,
  getActiveReviewByUser,
  listReviews,
  softDeleteReview,
} from "./functions/store.js";
import { resolveTextChannel, starsForRating } from "./functions/embeds.js";

export const reviewsCommands: SlashCommandDefinition[] = [
  {
    plugin: "reviews",
    data: new SlashCommandBuilder()
      .setName("review")
      .setDescription("Submit or manage server reviews")
      .addSubcommand((sub) => sub.setName("submit").setDescription("Open a form to review this server"))
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List recent reviews")
          .addIntegerOption((o) =>
            o.setName("rating").setDescription("Filter by star rating").setMinValue(1).setMaxValue(5),
          )
          .addUserOption((o) => o.setName("user").setDescription("Filter by reviewer")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a review by ID")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Review ID").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName("stats").setDescription("Show average rating and count")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "submit") {
        const auth = await requirePluginPermission(ctx, "reviews", "can_review");
        if (!auth) return;

        const config = zReviewsConfig.parse(auth.pluginConfig);
        const existing = await getActiveReviewByUser(guildId, auth.member.id);
        if (existing && !config.allow_edit) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("reviews.alreadyReviewed.title", "Already reviewed"),
              ctx.t("reviews.alreadyReviewed.description", "You have already submitted a review for this server."),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const eligibility = await checkFeedbackEligibility({
          member: auth.member,
          channelId: ctx.interaction.channelId,
          config: {
            min_messages: config.min_messages,
            min_account_age: config.min_account_age,
            min_member_age: config.min_member_age,
            cooldown: config.cooldown,
            allowed_roles: config.allowed_roles,
            blocked_roles: config.blocked_roles,
            ignored_channels: config.ignored_channels,
          },
          lastActionAt: existing?.updatedAt ?? null,
        });
        if (!eligibility.ok) {
          await ctx.interaction.reply(
            resultReply(ctx.t("reviews.notEligible.title", "Not eligible"), eligibility.message, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
          );
          return;
        }

        await ctx.interaction.showModal(
          buildReviewModal(ctx.t, {
            minRating: config.min_rating,
            maxRating: config.max_rating,
            requireText: config.require_text,
          }),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "reviews", "can_list");
        if (!auth) return;

        const rating = ctx.interaction.options.getInteger("rating");
        const user = ctx.interaction.options.getUser("user");
        const result = await listReviews(guildId, {
          rating,
          userId: user?.id ?? null,
          limit: 15,
          offset: 0,
        });

        const lines =
          result.reviews.length === 0
            ? [ctx.t("reviews.list.none", "No reviews found.")]
            : result.reviews.map((review) => {
                const who = review.anonymous ? ctx.t("reviews.anonymous", "Anonymous") : `<@${review.userId}>`;
                const snippet = review.content.trim().slice(0, 80) || ctx.t("reviews.list.noComment", "_no comment_");
                return `**#${review.id}** ${starsForRating(review.rating)} · ${who} — ${snippet}`;
              });

        const embed = setEmbedAuthor(baseEmbed(), ctx.t("reviews.list.title", "Reviews"), ctx.client, commandHeader(ctx.guildConfig));
        embed.setDescription(trimLines(lines.join("\n")).slice(0, 4000));
        embed.addFields(embedField(ctx.t("reviews.list.total", "Total"), String(result.total), true));

        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "reviews", "can_delete");
        if (!auth) return;

        const id = ctx.interaction.options.getInteger("id", true);
        const review = await softDeleteReview(guildId, id);
        if (!review) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("reviews.delete.notFoundTitle", "Not found"),
              ctx.t("reviews.delete.notFoundDescription", "Review #{id} was not found or is already deleted.", { id }),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const config = zReviewsConfig.parse(auth.pluginConfig);
        if (review.channelId && review.messageId) {
          const channel = await resolveTextChannel(ctx.interaction.client, review.channelId);
          const msg = channel ? await channel.messages.fetch(review.messageId).catch(() => null) : null;
          if (msg) await msg.delete().catch(() => null);
        }

        await ctx.interaction.reply(
          resultReply(
            ctx.t("reviews.delete.title", "Review deleted"),
            config.review_channel_id
              ? ctx.t(
                  "reviews.delete.descriptionWithChannel",
                  "Deleted review #{id}. The Discord post was removed if it still existed.",
                  { id },
                )
              : ctx.t("reviews.delete.description", "Deleted review #{id}.", { id }),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
        return;
      }

      if (sub === "stats") {
        const auth = await requirePluginPermission(ctx, "reviews", "can_list");
        if (!auth) return;

        const stats = await averageRating(guildId);
        await ctx.interaction.reply(
          resultReply(
            ctx.t("reviews.stats.title", "Review stats"),
            stats.count === 0
              ? ctx.t("reviews.stats.none", "No reviews yet.")
              : stats.count === 1
                ? ctx.t(
                    "reviews.stats.summaryOne",
                    "Average **{average}/5** {stars} across **{count}** review.",
                    { average: stats.average.toFixed(2), stars: starsForRating(Math.round(stats.average)), count: stats.count },
                  )
                : ctx.t(
                    "reviews.stats.summary",
                    "Average **{average}/5** {stars} across **{count}** reviews.",
                    { average: stats.average.toFixed(2), stars: starsForRating(Math.round(stats.average)), count: stats.count },
                  ),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
      }
    },
  },
];
