import {
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import { baseEmbed, discordTs, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import type { Translator } from "../../../i18n/index.js";
import type { Review } from "./store.js";

export function starsForRating(rating: number): string {
  const clamped = Math.max(1, Math.min(5, Math.round(rating)));
  return "★".repeat(clamped) + "☆".repeat(5 - clamped);
}

export function buildReviewEmbed(options: {
  client: Client;
  review: Review;
  authorTag: string;
  authorAvatar?: string | null;
  t: Translator;
}) {
  const { review, authorTag, authorAvatar, client, t } = options;
  const anonymousLabel = t("reviews.anonymous", "Anonymous");
  const publicAuthor = review.anonymous ? anonymousLabel : authorTag;
  const embed = setEmbedAuthor(baseEmbed(), t("reviews.embed.title", "Server review"), client, {
    tone: "neutral",
    emoji: "<:icons_star:1544417435636080741>",
  })
    .setDescription(review.content.trim() || t("reviews.embed.noComment", "_No comment_"))
    .addFields(
      embedField(t("reviews.embed.rating", "Rating"), `${starsForRating(review.rating)} (${review.rating}/5)`, true),
      embedField(t("reviews.embed.reviewer", "Reviewer"), review.anonymous ? anonymousLabel : `<@${review.userId}>`, true),
      embedField(t("reviews.embed.id", "ID"), `#${review.id}`, true),
    )
    .setFooter({ text: `${publicAuthor} · ${discordTs(review.updatedAt)}` });

  if (!review.anonymous && authorAvatar) {
    embed.setThumbnail(authorAvatar);
  }
  return embed;
}

export async function resolveTextChannel(
  client: Client,
  channelId: string | undefined,
): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  const channel =
    client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased() || channel.isDMBased()) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return null;
  }
  return channel;
}
