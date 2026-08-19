import type { GuildMember, Message, TextChannel } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zAutorepliesConfig } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { buildPersistPayload } from "../../persist/functions/messageBuilder.js";
import { getAutoreplyWebhook } from "../../persist/functions/webhook.js";
import {
  autoreplyAsSticky,
  autoreplyHasContent,
  autoreplyPassesFilters,
  normalizeAutoreplyRules,
} from "./rules.js";
import { shouldTriggerAutoreplyByCadence } from "./state.js";

const ALL_CHANNELS = "*";

export async function handleAutoreplyMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || message.webhookId) return;
  if (!message.channel.isTextBased() || message.channel.isDMBased()) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "autoreplies")) return;

  const pluginConfig = zAutorepliesConfig.parse(
    resolvePluginConfig(guildConfig, "autoreplies", getPluginDefaultOverrides("autoreplies")),
  );

  const rules = normalizeAutoreplyRules(pluginConfig.rules).filter(
    (rule) => rule.channel_id === ALL_CHANNELS || rule.channel_id === message.channel.id,
  );

  for (const rule of rules) {
    if (!autoreplyHasContent(rule)) continue;
    if (!autoreplyPassesFilters(message, rule)) continue;

    if (rule.every_n || rule.cooldown_seconds) {
      const allowed = await shouldTriggerAutoreplyByCadence({
        guildId: message.guild.id,
        ruleId: rule.id,
        channelId: message.channel.id,
        everyN: rule.every_n,
        cooldownSeconds: rule.cooldown_seconds,
      });
      if (!allowed) continue;
    }

    const channel = message.channel as TextChannel;
    const sticky = autoreplyAsSticky(rule);
    const built = buildPersistPayload(sticky, {
      client: message.client,
      guild: message.guild,
      channel,
      user: message.author,
      member: message.member as GuildMember | null,
    });
    if (built.empty) continue;

    if (rule.webhook) {
      const hook = await getAutoreplyWebhook(channel);
      if (hook) {
        const sent = await hook.send(built.webhookPayload).catch(() => null);
        if (sent) continue;
      }
    }

    if (rule.reply_to_message === false) {
      await channel.send(built.payload).catch(() => null);
    } else {
      await message.reply(built.payload).catch(() => null);
    }
  }
}
