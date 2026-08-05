import type { Message, TextChannel } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zAutorepliesConfig } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { autoreplyPassesFilters, normalizeAutoreplyRules } from "./rules.js";
import { shouldTriggerAutoreplyByCadence } from "./state.js";

const ALL_CHANNELS = "*";

export async function handleAutoreplyMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;
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
    if (rule.reply_to_message === false) {
      await channel.send({ content: rule.response }).catch(() => null);
    } else {
      await message.reply({ content: rule.response }).catch(() => null);
    }
  }
}
