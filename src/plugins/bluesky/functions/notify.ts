import { MessageFlags, type Client, type TopLevelComponentData } from "discord.js";
import { interpolateTokens } from "../../social/functions/notifyShared.js";
import { pingComponent } from "../../../core/responses.js";
import { getLogger } from "../../../core/logger.js";
import type { BlueskyActor, BlueskyPost, BlueskyPostKind, BlueskyProfile } from "./api.js";
import { buildPostCard } from "./card.js";
import { completeDelivery, deleteDelivery, reserveDelivery, type BlueskyFeedRow } from "./store.js";
const log = getLogger("bluesky");

/** Every `{token}` a feed's message can use. Keep in sync with the website's BLUESKY_TOKENS. */
export const BLUESKY_TOKENS = [
  "post_text",
  "post_url",
  "post_type",
  "post_time",
  "author_name",
  "author_handle",
  "author_url",
  "creator_name",
  "creator_handle",
  "creator_url",
  "creator_followers",
  "creator_posts",
] as const;

const POST_TYPE_LABEL: Record<BlueskyPostKind, string> = {
  post: "post",
  reply: "reply",
  quote: "quote post",
  repost: "repost",
};

/**
 * `creator` is the followed account (who posted or reposted); `author` wrote the post itself, and
 * only differs from the creator on reposts.
 */
export function buildBlueskyTokens(
  post: BlueskyPost,
  kind: BlueskyPostKind,
  creator: BlueskyActor & Partial<Pick<BlueskyProfile, "followersCount" | "postsCount">>,
): Record<(typeof BLUESKY_TOKENS)[number], string> {
  return {
    post_text: post.text,
    post_url: post.url,
    post_type: POST_TYPE_LABEL[kind],
    post_time: `<t:${Math.floor(post.createdAt.getTime() / 1000)}:R>`,
    author_name: post.author.displayName,
    author_handle: `@${post.author.handle}`,
    author_url: post.author.url,
    creator_name: creator.displayName,
    creator_handle: `@${creator.handle}`,
    creator_url: creator.url,
    creator_followers: creator.followersCount !== undefined ? creator.followersCount.toLocaleString("en-US") : "",
    creator_posts: creator.postsCount !== undefined ? creator.postsCount.toLocaleString("en-US") : "",
  };
}

/** The top message: interpolated text with role pings substituted at `{roles}`, else prepended. */
export function buildTopMessage(messageContent: string, mentionRoleIds: string[], tokens: Record<string, string>): string {
  const rendered = interpolateTokens(messageContent, tokens).trim();
  const roleMentions = mentionRoleIds.map((id) => `<@&${id}>`).join(" ");
  if (!roleMentions) return rendered.slice(0, 2000);
  if (rendered.includes("{roles}")) return rendered.replace(/\{roles\}/g, roleMentions).slice(0, 2000);
  return (rendered ? `${roleMentions} ${rendered}` : roleMentions).slice(0, 2000);
}

export type DeliverInput = {
  feed: Pick<BlueskyFeedRow, "id" | "guildId" | "discordChannelId" | "messageContent" | "mentionRoleIds" | "options">;
  post: BlueskyPost;
  kind: BlueskyPostKind;
  creator: BlueskyActor & Partial<Pick<BlueskyProfile, "followersCount" | "postsCount">>;
  replyToHandle?: string | null;
  /** Test sends don't dedupe against (or record as) the feed's real deliveries. */
  test?: boolean;
};

/** Posts a card for one feed. Never throws; logs and returns false on failure (or if already delivered). */
export async function deliverPost(client: Client, input: DeliverInput): Promise<boolean> {
  const { feed, post, kind } = input;
  const channel = await client.channels.fetch(feed.discordChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    log.warn(`[bluesky] feed ${feed.id}: target channel ${feed.discordChannelId} is unavailable.`);
    return false;
  }

  // Reserved before sending so the card's button custom IDs can carry the delivery id. Skipped
  // entirely (no buttons) when the feed hides them.
  let deliveryId: number | null = null;
  if (feed.options.show_buttons || !input.test) {
    deliveryId = await reserveDelivery({
      feedId: input.test ? null : feed.id,
      guildId: feed.guildId,
      channelId: channel.id,
      postUri: post.uri,
      postCid: post.cid,
    });
    if (deliveryId === null) return false; // this feed already posted it
  }

  try {
    const tokens = buildBlueskyTokens(post, kind, input.creator);
    const top = buildTopMessage(feed.messageContent, feed.mentionRoleIds, tokens);
    const { container, row } = buildPostCard(post, {
      accentColor: feed.options.accent_color,
      showMedia: feed.options.show_media,
      deliveryId: feed.options.show_buttons ? deliveryId : null,
      repostedBy: kind === "repost" ? input.creator : null,
      replyToHandle: input.replyToHandle,
    });
    const components: TopLevelComponentData[] = [container.toContainerComponent([row.toJSON()])];
    if (top) components.unshift(pingComponent(top));

    const message = await channel.send({
      components,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { roles: feed.mentionRoleIds, parse: [] },
    });
    if (deliveryId !== null) await completeDelivery(deliveryId, message.id);
    return true;
  } catch (error) {
    if (deliveryId !== null) await deleteDelivery(deliveryId).catch(() => undefined);
    log.error(`[bluesky] feed ${feed.id}: failed to send post ${post.uri}:`, error);
    return false;
  }
}
