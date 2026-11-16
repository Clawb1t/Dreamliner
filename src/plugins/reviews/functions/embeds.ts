import {
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import { baseEmbed, discordTs, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import { translatorFor, type Translator } from "../../../i18n/index.js";
import { containerEdit, containerReply } from "../../../core/responses.js";
import { updateReview, type Review } from "./store.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";

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
  const title = review.featuredAt ? t("reviews.embed.featuredTitle", "Featured review") : t("reviews.embed.title", "Server review");
  const embed = setEmbedAuthor(baseEmbed(), title, client, {
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

  if (review.reply?.trim()) {
    embed.addFields(embedField(t("reviews.embed.reply", "Reply from the staff team"), review.reply.trim().slice(0, 1024), false));
  }

  if (!review.anonymous && authorAvatar) {
    embed.setThumbnail(authorAvatar);
  }
  return embed;
}

/** Removes a review's Discord post, if it still exists (best effort). */
export async function deleteReviewPost(client: Client, guildId: string, review: Review): Promise<void> {
  if (!review.channelId || !review.messageId) return;
  const channel = await resolveTextChannel(client, guildId, review.channelId);
  const msg = channel ? await channel.messages.fetch(review.messageId).catch(() => null) : null;
  if (msg) await msg.delete().catch(() => null);
}

/**
 * Brings a review's Discord post in line with the review: deleted or hidden reviews lose their
 * post, anything else is edited in place (or posted again in the reviews channel when the old post
 * is gone or was in another channel). Featured reviews are pinned when the bot can pin there.
 * Returns a short note for the dashboard when something couldn't be done.
 */
export async function syncReviewPost(
  client: Client,
  guildId: string,
  review: Review,
  reviewChannelId: string | undefined,
): Promise<{ review: Review; note: string | null }> {
  if (review.deletedAt || review.hiddenAt) {
    await deleteReviewPost(client, guildId, review);
    if (review.channelId || review.messageId) {
      review = (await updateReview(review.id, { channelId: null, messageId: null })) ?? review;
    }
    return { review, note: null };
  }

  const channel = await resolveTextChannel(client, guildId, reviewChannelId);
  if (!channel) {
    return { review, note: "Saved, but there's no reviews channel to post in, so Discord wasn't updated." };
  }

  const user = await client.users.fetch(review.userId).catch(() => null);
  const { t } = await translatorFor(review.userId);
  const embed = buildReviewEmbed({
    client,
    review,
    authorTag: user?.tag ?? review.userId,
    authorAvatar: user?.displayAvatarURL({ size: 128 }) ?? null,
    t,
  });

  let message: Message | null = null;
  try {
    if (review.channelId === channel.id && review.messageId) {
      const existing = await channel.messages.fetch(review.messageId).catch(() => null);
      if (existing) message = await existing.edit(containerEdit(embed));
    }
    if (!message) {
      // The old post (if any) was elsewhere: take it down so the review isn't posted twice.
      if (review.channelId && review.channelId !== channel.id) await deleteReviewPost(client, guildId, review);
      message = await channel.send(containerReply(embed));
    }
  } catch {
    return { review, note: "Saved, but Dreamliner couldn't post in the reviews channel. Check its permissions there." };
  }

  if (review.channelId !== channel.id || review.messageId !== message.id) {
    review = (await updateReview(review.id, { channelId: channel.id, messageId: message.id })) ?? review;
  }

  let note: string | null = null;
  if (review.featuredAt && !message.pinned) {
    const pinned = await message.pin().then(() => true).catch(() => false);
    if (!pinned) note = "Featured, but Dreamliner couldn't pin the post. It needs Pin Messages in the reviews channel.";
  } else if (!review.featuredAt && message.pinned) {
    await message.unpin().catch(() => null);
  }
  return { review, note };
}

export async function resolveTextChannel(
  client: Client,
  guildId: string,
  channelId: string | undefined,
): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  const channel = await fetchGuildChannel(client, guildId, channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return null;
  }
  return channel;
}
