import type { Message } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zAutoreactionsConfig } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { messagePassesFilters, normalizeAutoreactionRules, AUTOREACTION_ALL_CHANNELS } from "./rules.js";
import { shouldTriggerByCadence } from "./state.js";

export async function handleAutoreactionMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "autoreactions")) return;

  const pluginConfig = zAutoreactionsConfig.parse(
    resolvePluginConfig(guildConfig, "autoreactions", getPluginDefaultOverrides("autoreactions")),
  );

  const rules = normalizeAutoreactionRules(pluginConfig.rules).filter(
    (rule) => rule.channel_id === AUTOREACTION_ALL_CHANNELS || rule.channel_id === message.channel.id,
  );

  for (const rule of rules) {
    if (!messagePassesFilters(message, rule)) continue;

    if (rule.every_n || rule.cooldown_seconds) {
      const allowed = await shouldTriggerByCadence({
        guildId: message.guild.id,
        ruleId: rule.id,
        channelId: message.channel.id,
        everyN: rule.every_n,
        cooldownSeconds: rule.cooldown_seconds,
      });
      if (!allowed) continue;
    }

    await message.react(rule.emoji).catch(() => null);
  }
}
