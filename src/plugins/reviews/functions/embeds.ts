import {
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import { baseEmbed, embedField, setEmbedAuthor } from "../../../core/embeds.js";
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
}) {
  const { review, authorTag, authorAvatar, client } = options;
  const publicAuthor = review.anonymous ? "Anonymous" : authorTag;
  const embed = setEmbedAuthor(baseEmbed(), "Server review", client, {
    tone: "neutral",
    emoji: "<:icons_star:1544417435636080741>",
  })
    .setDescription(review.content.trim() || "_No comment_")
    .addFields(
      embedField("Rating", `${starsForRating(review.rating)} (${review.rating}/5)`, true),
      embedField("Reviewer", review.anonymous ? "Anonymous" : `<@${review.userId}>`, true),
      embedField("ID", `#${review.id}`, true),
    )
    .setFooter({ text: publicAuthor })
    .setTimestamp(review.updatedAt);

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
