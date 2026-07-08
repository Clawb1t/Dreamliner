import type { Message } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zAutoreactionsConfig } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { normalizeAutoreactionRules } from "./rules.js";

const ALL_CHANNELS = "*";

function messageMatchesRegex(content: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(content);
  } catch {
    return false;
  }
}

export async function handleAutoreactionMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "autoreactions")) return;

  const pluginConfig = zAutoreactionsConfig.parse(
    resolvePluginConfig(guildConfig, "autoreactions", getPluginDefaultOverrides("autoreactions")),
  );

  const rules = normalizeAutoreactionRules(pluginConfig.rules).filter(
    (rule) => rule.channel_id === ALL_CHANNELS || rule.channel_id === message.channel.id,
  );

  for (const rule of rules) {
    if (rule.regex && !messageMatchesRegex(message.content ?? "", rule.regex)) continue;
    await message.react(rule.emoji).catch(() => null);
  }
}
