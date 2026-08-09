import {
  Events,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { DEFAULT_LANGUAGE_CODE, flagForLanguage, languagesMatch } from "../../../core/languages.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getTranslationPluginConfig } from "../../../core/guildHelpers.js";
import { buildAutoTranslatePayload, buildAutoTranslateWebhookPayload } from "./embed.js";
import { detectLanguage, translateText, waitGuildTranslateSlot } from "./translate.js";
import { getAutoTranslateWebhook } from "./webhook.js";

const recentlyTranslated = new Map<string, number>();
const TRANSLATE_DEDUP_MS = 60_000;
const MIN_DETECT_LENGTH = 4;

function pruneDedup(now: number) {
  for (const [key, at] of recentlyTranslated) {
    if (now - at > TRANSLATE_DEDUP_MS) recentlyTranslated.delete(key);
  }
}

function markTranslated(messageId: string) {
  const now = Date.now();
  pruneDedup(now);
  recentlyTranslated.set(messageId, now);
}

function wasRecentlyTranslated(messageId: string): boolean {
  const at = recentlyTranslated.get(messageId);
  if (!at) return false;
  if (Date.now() - at > TRANSLATE_DEDUP_MS) {
    recentlyTranslated.delete(messageId);
    return false;
  }
  return true;
}

function usableContent(message: Message): string {
  return (message.content ?? "").trim();
}

export async function handleAutoTranslateMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;
  if (message.system) return;

  const content = usableContent(message);
  if (content.length < MIN_DETECT_LENGTH) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "translation")) return;

  const pluginConfig = getTranslationPluginConfig(guildConfig);
  if (!pluginConfig.auto_translate) return;
  if (pluginConfig.ignored_channels.includes(message.channelId)) return;

  const defaultLanguage = guildConfig.default_language || DEFAULT_LANGUAGE_CODE;

  try {
    await waitGuildTranslateSlot(message.guild.id);
    const detected = await detectLanguage(content);
    if (!detected || languagesMatch(detected, defaultLanguage)) return;

    const flag = flagForLanguage(defaultLanguage);
    await message.react(flag);
  } catch (error) {
    console.warn(
      `[translation] auto-translate detect/react failed in guild ${message.guild.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function handleAutoTranslateReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;

  let fullReaction = reaction;
  if (fullReaction.partial) {
    try {
      fullReaction = await fullReaction.fetch();
    } catch {
      return;
    }
  }

  let message = fullReaction.message;
  if (message.partial) {
    try {
      message = await message.fetch();
    } catch {
      return;
    }
  }

  if (!message.guild) return;
  const content = usableContent(message as Message);
  if (!content) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "translation")) return;

  const pluginConfig = getTranslationPluginConfig(guildConfig);
  if (!pluginConfig.auto_translate) return;
  if (pluginConfig.ignored_channels.includes(message.channelId)) return;

  const defaultLanguage = guildConfig.default_language || DEFAULT_LANGUAGE_CODE;
  const expectedFlag = flagForLanguage(defaultLanguage);
  const emojiName = fullReaction.emoji.name ?? "";
  if (emojiName !== expectedFlag) return;

  if (wasRecentlyTranslated(message.id)) return;

  try {
    await waitGuildTranslateSlot(message.guild.id);
    const translated = await translateText(content, defaultLanguage, "auto");
    if (languagesMatch(translated.from, translated.to) && translated.text === content) {
      markTranslated(message.id);
      return;
    }

    markTranslated(message.id);

    const channel = message.channel;
    if (!channel.isTextBased() || channel.isDMBased()) return;

    const webhook = await getAutoTranslateWebhook(channel);
    if (webhook) {
      const webhookPayload = buildAutoTranslateWebhookPayload({
        translated: translated.text,
        author: message.author,
      });
      await webhook.send(webhookPayload).catch(() => null);
      return;
    }

    // No Manage Webhooks → plain bot reply with text-only container
    const payload = buildAutoTranslatePayload({ translated: translated.text });
    await message.reply(payload).catch(async () => {
      if ("send" in channel) {
        await (channel as import("discord.js").TextChannel).send(payload).catch(() => null);
      }
    });
  } catch {
    // Ignore translation failures on reaction
  }
}

export const autoTranslateEvents = [
  {
    name: Events.MessageCreate,
    execute: async (_client: Client, message: unknown) => {
      await handleAutoTranslateMessage(message as Message);
    },
  },
  {
    name: Events.MessageReactionAdd,
    execute: async (_client: Client, reaction: unknown, user: unknown) => {
      await handleAutoTranslateReaction(
        reaction as MessageReaction | PartialMessageReaction,
        user as User | PartialUser,
      );
    },
  },
];
