import { ChannelType, type GuildMember, type Message, type TextChannel, type ThreadAutoArchiveDuration } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zAutothreadsConfig } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { renderTemplate } from "../../../core/templates.js";
import { buildPersistPayload } from "../../persist/functions/messageBuilder.js";
import { getAutothreadWebhook } from "../../persist/functions/webhook.js";
import {
  autothreadAsSticky,
  autothreadHasContent,
  autothreadPassesFilters,
  normalizeAutothreadRules,
} from "./rules.js";
import { shouldTriggerAutothreadByCadence } from "./state.js";

const ALL_CHANNELS = "*";
const THREAD_NAME_MAX = 100;

function threadNameFromRule(message: Message, nameTemplate: string): string {
  const rendered = renderTemplate(nameTemplate, {
    guild: message.guild,
    channel: message.channel as TextChannel,
    user: message.author,
    member: message.member as GuildMember | null,
  }).slice(0, THREAD_NAME_MAX);
  return rendered.length > 0 ? rendered : "Thread";
}

export async function handleAutothreadMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || message.webhookId) return;
  if (!message.channel.isTextBased() || message.channel.isDMBased() || message.channel.isThread()) return;
  if (
    message.channel.type !== ChannelType.GuildText &&
    message.channel.type !== ChannelType.GuildAnnouncement
  ) {
    return;
  }
  if (message.hasThread) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "autothreads")) return;

  const pluginConfig = zAutothreadsConfig.parse(
    resolvePluginConfig(guildConfig, "autothreads", getPluginDefaultOverrides("autothreads")),
  );

  const rules = normalizeAutothreadRules(pluginConfig.rules).filter(
    (rule) => rule.channel_id === ALL_CHANNELS || rule.channel_id === message.channel.id,
  );

  const channel = message.channel as TextChannel;

  for (const rule of rules) {
    if (message.hasThread) return;
    if (!autothreadHasContent(rule)) continue;
    if (!autothreadPassesFilters(message, rule)) continue;

    if (rule.every_n || rule.cooldown_seconds) {
      const allowed = await shouldTriggerAutothreadByCadence({
        guildId: message.guild.id,
        ruleId: rule.id,
        channelId: message.channel.id,
        everyN: rule.every_n,
        cooldownSeconds: rule.cooldown_seconds,
      });
      if (!allowed) continue;
    }

    const sticky = autothreadAsSticky(rule);
    const built = buildPersistPayload(sticky, {
      client: message.client,
      guild: message.guild,
      channel,
      user: message.author,
      member: message.member as GuildMember | null,
    });
    if (built.empty) continue;

    const thread = await message
      .startThread({
        name: threadNameFromRule(message, rule.thread_name),
        autoArchiveDuration: rule.auto_archive_minutes as ThreadAutoArchiveDuration,
        ...(rule.thread_slowmode_seconds ? { rateLimitPerUser: rule.thread_slowmode_seconds } : {}),
      })
      .catch(() => null);
    if (!thread) continue;

    if (rule.webhook) {
      const hook = await getAutothreadWebhook(channel);
      if (hook) {
        const sent = await hook
          .send({ ...built.webhookPayload, threadId: thread.id })
          .catch(() => null);
        if (sent) return;
      }
    }

    await thread.send(built.payload).catch(() => null);
    return;
  }
}
