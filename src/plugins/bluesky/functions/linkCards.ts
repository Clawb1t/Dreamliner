/**
 * Opt-in (`link_cards`): when a member pastes a bsky.app post link, reply with the same
 * interactive post card feeds use, so the post can be liked/reposted from Discord. Discord's own
 * link preview is hidden when the bot can manage messages, so the post isn't shown twice.
 */
import { MessageFlags, PermissionFlagsBits, type Message } from "discord.js";
import { BLUESKY_BLUE } from "../../../config/schemas/bluesky.js";
import { getLogger } from "../../../core/logger.js";
import { extractPostUrls, getPost, resolvePostUrl } from "./api.js";
import { buildPostCard } from "./card.js";
import { activeBlueskySettings } from "./guildSettings.js";
import { completeDelivery, deleteDelivery, reserveDelivery } from "./store.js";
const log = getLogger("bluesky");

export async function handleBlueskyLinkMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild() || !message.content.includes("/post/")) return;
  const [url] = extractPostUrls(message.content);
  if (!url) return;

  const settings = await activeBlueskySettings(message.guildId);
  if (!settings?.link_cards) return;

  const uri = await resolvePostUrl(url);
  const post = uri ? await getPost(uri).catch(() => null) : null;
  if (!post) return;

  const deliveryId = await reserveDelivery({
    feedId: null,
    guildId: message.guildId,
    channelId: message.channelId,
    postUri: post.uri,
    postCid: post.cid,
  });
  if (deliveryId === null) return;

  try {
    const { container, row } = buildPostCard(post, { accentColor: BLUESKY_BLUE, showMedia: true, deliveryId });
    const reply = await message.reply({
      components: [container.toContainerComponent([row.toJSON()])],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], repliedUser: false },
    });
    await completeDelivery(deliveryId, reply.id);

    const me = message.guild.members.me ?? (await message.guild.members.fetchMe().catch(() => null));
    if (me && message.channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
      await message.suppressEmbeds(true).catch(() => undefined);
    }
  } catch (error) {
    await deleteDelivery(deliveryId).catch(() => undefined);
    log.warn(`[bluesky] link card for ${post.uri} failed in ${message.channelId}:`, error);
  }
}
