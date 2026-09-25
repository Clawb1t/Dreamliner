import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { baseEmbed, type ResultContainer } from "../../../core/embeds.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { BLUESKY_EMOJIS, blueskyLikeId, blueskyRepostId } from "../constants.js";
import type { BlueskyActor, BlueskyPost } from "./api.js";

export const MAX_CARD_IMAGES = 4;
const QUOTE_PREVIEW_CHARS = 400;

export type PostCardOptions = {
  accentColor: number;
  showMedia: boolean;
  /** The `bluesky_deliveries` row this card is recorded as. Like/Repost buttons need it; null shows only the Open link. */
  deliveryId: number | null;
  /** Set when a followed account reposted someone else's post. */
  repostedBy?: BlueskyActor | null;
  /** Handle of the post being replied to, when known. */
  replyToHandle?: string | null;
};

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The images the card shows: the post's photos, else its video thumbnail, else its link preview image. */
export function cardMedia(post: BlueskyPost): string[] {
  if (post.images.length) return post.images.slice(0, MAX_CARD_IMAGES).map((img) => img.url);
  if (post.videoThumbnailUrl) return [post.videoThumbnailUrl];
  if (post.external?.thumbUrl) return [post.external.thumbUrl];
  return [];
}

export function cardDescription(post: BlueskyPost, options: Pick<PostCardOptions, "repostedBy" | "replyToHandle">): string {
  const lines: string[] = [];
  if (options.repostedBy) {
    lines.push(`-# ${BLUESKY_EMOJIS.repost} Reposted by [${options.repostedBy.displayName}](${options.repostedBy.url})`);
  } else if (post.kind === "reply") {
    lines.push(`-# ${BLUESKY_EMOJIS.reply} ${options.replyToHandle ? `Replying to @${options.replyToHandle}` : "Reply"}`);
  }
  lines.push(`**${post.author.displayName}** · [@${post.author.handle}](${post.author.url})`);

  const body: string[] = [lines.join("\n")];
  if (post.text.trim()) body.push(post.text.trim());
  if (post.quoted) {
    const quoted = [
      `**${post.quoted.author.displayName}** · [@${post.quoted.author.handle}](${post.quoted.url})`,
      truncate(post.quoted.text.trim(), QUOTE_PREVIEW_CHARS),
    ].filter(Boolean);
    body.push(quoteBlock(quoted.join("\n")));
  }
  if (post.external) {
    body.push(`${BLUESKY_EMOJIS.link} [${post.external.title || post.external.url}](${post.external.url})`);
  }
  return body.join("\n\n");
}

/** Like / Repost / Open row. Like and Repost only when the card has a delivery to point back at. */
export function cardButtonsRow(post: BlueskyPost, deliveryId: number | null): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (deliveryId !== null) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(blueskyLikeId(deliveryId))
        .setLabel("Like")
        .setEmoji(BLUESKY_EMOJIS.like)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(blueskyRepostId(deliveryId))
        .setLabel("Repost")
        .setEmoji(parseComponentEmoji(BLUESKY_EMOJIS.repost) ?? "🔁")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  row.addComponents(new ButtonBuilder().setLabel("Open on Bluesky").setStyle(ButtonStyle.Link).setURL(post.url));
  return row;
}

/**
 * The Components V2 post card shared by feed notifications, pasted-link cards and test sends:
 * author avatar as the thumbnail, the post (and any quoted post) as text, up to four images, a
 * small "Bluesky · time" footer, and the buttons inside the container.
 */
export function buildPostCard(post: BlueskyPost, options: PostCardOptions): { container: ResultContainer; row: ActionRowBuilder<ButtonBuilder> } {
  const container = baseEmbed()
    .setColor(options.accentColor)
    .setThumbnail(post.author.avatarUrl)
    .setDescription(cardDescription(post, options))
    .setFooter({ text: `${BLUESKY_EMOJIS.bluesky} Bluesky · <t:${Math.floor(post.createdAt.getTime() / 1000)}:R>` });
  if (options.showMedia) container.setImages(cardMedia(post));
  return { container, row: cardButtonsRow(post, options.deliveryId) };
}
