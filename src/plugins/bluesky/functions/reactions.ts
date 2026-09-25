/**
 * 💙 / 🩵 on any message that shows a Bluesky post likes it as the reacting member; removing the
 * reaction removes the like. The post comes from the card's delivery record when Dreamliner sent
 * the message, otherwise from the first bsky.app post link in the message or its embeds.
 */
import type { Client, Message, MessageReaction, PartialMessage, PartialMessageReaction, PartialUser, User } from "discord.js";
import { containerReply } from "../../../core/responses.js";
import { getLogger } from "../../../core/logger.js";
import { translatorFor } from "../../../i18n/index.js";
import { LIKE_REACTIONS } from "../constants.js";
import { like, unlike } from "./actions.js";
import { extractPostUrls, getPost, resolvePostUrl } from "./api.js";
import { activeBlueskySettings } from "./guildSettings.js";
import { connectPrompt } from "./messages.js";
import { getDeliveryByMessage } from "./store.js";
const log = getLogger("bluesky");

const PROMPT_COOLDOWN_MS = 24 * 60 * 60_000;
const lastPromptAt = new Map<string, number>();

async function resolveMessage(message: Message | PartialMessage): Promise<Message | null> {
  if (!message.partial) return message;
  return message.fetch().catch(() => null);
}

/** The post a message shows, as `{ uri, cid? }`. `cid` is only needed (and only fetched) to like. */
async function findPost(message: Message, needCid: boolean): Promise<{ uri: string; cid?: string } | null> {
  const delivery = await getDeliveryByMessage(message.id);
  if (delivery) return { uri: delivery.postUri, cid: delivery.postCid };

  const haystack = [
    message.content,
    ...message.embeds.flatMap((embed) => [embed.url ?? "", embed.description ?? ""]),
  ].join("\n");
  const [url] = extractPostUrls(haystack);
  if (!url) return null;
  const uri = await resolvePostUrl(url);
  if (!uri) return null;
  if (!needCid) return { uri };
  const post = await getPost(uri).catch(() => null);
  return post ? { uri, cid: post.cid } : null;
}

/** DMs the connect prompt, at most once a day per member so a reaction habit doesn't spam them. */
async function promptToConnect(client: Client, user: User, expired: boolean): Promise<void> {
  const last = lastPromptAt.get(user.id) ?? 0;
  if (Date.now() - last < PROMPT_COOLDOWN_MS) return;
  lastPromptAt.set(user.id, Date.now());
  const { t } = await translatorFor(user.id);
  const { container, rows } = connectPrompt(client, t, expired);
  await user.send(containerReply(container, false, rows)).catch(() => undefined);
}

export async function handleBlueskyReaction(
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
  rawUser: User | PartialUser,
  type: "add" | "remove",
): Promise<void> {
  if (!LIKE_REACTIONS.has(reaction.emoji.name ?? "")) return;
  if (rawUser.bot) return;
  const message = await resolveMessage(reaction.message);
  if (!message?.guildId) return;

  const settings = await activeBlueskySettings(message.guildId);
  if (!settings?.reaction_likes) return;

  const post = await findPost(message, type === "add").catch((error: unknown) => {
    log.warn(`[bluesky] couldn't read the post on message ${message.id}:`, error);
    return null;
  });
  if (!post) return;

  const user = rawUser.partial ? await rawUser.fetch().catch(() => null) : rawUser;
  if (!user) return;

  if (type === "remove") {
    await unlike(user.id, post.uri);
    return;
  }
  if (!post.cid) return;
  const result = await like(user.id, post.uri, post.cid);
  if (!result.ok && (result.reason === "not_connected" || result.reason === "expired")) {
    await promptToConnect(client, user, result.reason === "expired");
  }
}
