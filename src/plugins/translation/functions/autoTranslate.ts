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
import {
  isMeaningfulTranslation,
  prepareForLanguageDetect,
} from "./detectGuard.js";
import { buildAutoTranslatePayload, buildAutoTranslateWebhookPayload } from "./embed.js";
import { translateText, waitGuildTranslateSlot } from "./translate.js";
import { getAutoTranslateWebhook } from "./webhook.js";
import { isDreamlinerAeroActive } from "../../../bridge/dreamlinerAero.js";

const recentlyTranslated = new Map<string, number>();
const TRANSLATE_DEDUP_MS = 60_000;

function pruneDedup(now: number) {
  for (const [key, at] of recentlyTranslated) {
    if (now - at > TRANSLATE_DEDUP_MS) recentlyTranslated.delete(key);
  }
}

/** Atomically claim a message so concurrent reactions only produce one translation. */
function claimTranslation(messageId: string): boolean {
  const now = Date.now();
  pruneDedup(now);
  const at = recentlyTranslated.get(messageId);
  if (at && now - at <= TRANSLATE_DEDUP_MS) return false;
  recentlyTranslated.set(messageId, now);
  return true;
}

function usableContent(message: Message): string {
  return (message.content ?? "").trim();
}

export async function handleAutoTranslateMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;
  if (message.system) return;

  const content = usableContent(message);
  const prepared = prepareForLanguageDetect(content);
  if (!prepared) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "translation")) return;

  const pluginConfig = getTranslationPluginConfig(guildConfig);
  if (!pluginConfig.auto_translate) return;
  if (!(await isDreamlinerAeroActive(message.guild.id))) return;
  if (pluginConfig.ignored_channels.includes(message.channelId)) return;

  const defaultLanguage = guildConfig.default_language || DEFAULT_LANGUAGE_CODE;

  try {
    await waitGuildTranslateSlot(message.guild.id);
    // One translate pass: must detect a different language AND change the text.
    const probe = await translateText(prepared, defaultLanguage, "auto");
    if (languagesMatch(probe.from, defaultLanguage)) return;
    if (!isMeaningfulTranslation(prepared, probe.text)) return;

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
  if (!(await isDreamlinerAeroActive(message.guild.id))) return;
  if (pluginConfig.ignored_channels.includes(message.channelId)) return;

  const defaultLanguage = guildConfig.default_language || DEFAULT_LANGUAGE_CODE;
  const expectedFlag = flagForLanguage(defaultLanguage);
  const emojiName = fullReaction.emoji.name ?? "";
  if (emojiName !== expectedFlag) return;

  // Claim before any await so parallel reactions cannot all send a reply.
  if (!claimTranslation(message.id)) return;

  try {
    await waitGuildTranslateSlot(message.guild.id);
    const translated = await translateText(content, defaultLanguage, "auto");
    if (languagesMatch(translated.from, translated.to) && translated.text === content) {
      return;
    }

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
