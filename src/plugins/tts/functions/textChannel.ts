import type { Message } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { hasPermission, resolveEffectivePluginConfig } from "../../../core/permissionRoles.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { zTtsConfig } from "../../../config/schemas/tts.js";
import { synthesize } from "./synth.js";
import { speakInChannel } from "./session.js";
import { getUserVoice } from "./userVoice.js";
import { sanitizeSpokenText } from "./sanitizeSpokenText.js";
import { isTtsBlacklisted } from "./blacklist.js";

/** Per-member cooldown tracker, keyed `${guildId}:${userId}`. Cleared on process restart. */
const lastUse = new Map<string, number>();

/**
 * The TTS text channel: any message there from a member currently in a voice channel gets
 * spoken there automatically, in that member's chosen voice (or the guild default).
 */
export async function handleTtsTextChannelMessage(message: Message): Promise<void> {
  if (!message.guild || !message.member || message.author.bot || message.webhookId) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "tts")) return;

  const rawConfig = guildConfig.plugins.tts?.config;
  const textChannelId = typeof rawConfig?.text_channel_id === "string" ? rawConfig.text_channel_id : "";
  if (!textChannelId || message.channel.id !== textChannelId) return;

  if (!(await hasPermission(message.guild.id, "tts", "can_speak", message.member, guildConfig))) {
    return;
  }

  if (await isTtsBlacklisted(message.guild.id, message.author.id)) return;

  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return;

  const rawText = message.content.trim();
  if (!rawText) return;

  const text = sanitizeSpokenText(rawText);
  if (!text) return; // e.g. the whole message was just a link or a gif filename

  const config = parsePluginConfig(
    zTtsConfig,
    await resolveEffectivePluginConfig(message.guild.id, "tts", message.member, guildConfig),
  );

  const cooldownKey = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const elapsed = now - (lastUse.get(cooldownKey) ?? 0);
  if (elapsed < config.cooldown_seconds * 1000) return;

  const truncated = text.length > config.max_characters ? text.slice(0, config.max_characters) : text;
  const spokenText = config.announce_speaker ? `${message.member.displayName} said: ${truncated}` : truncated;

  const personalVoice = await getUserVoice(message.author.id);
  const voice = personalVoice || config.voice || null;

  const speech = await synthesize(spokenText, config, voice);
  if ("error" in speech) {
    await message.react("❌").catch(() => {});
    return;
  }

  const spoken = await speakInChannel(voiceChannel, speech.audio);
  if (!spoken.ok) {
    await message.react("❌").catch(() => {});
    return;
  }

  lastUse.set(cooldownKey, now);
}
