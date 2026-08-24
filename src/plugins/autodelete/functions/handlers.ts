import type { Message } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { autodeleteRuleByChannel, loadAutodeleteConfig } from "./config.js";

export async function handleAutodeleteMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || !message.channel.isTextBased()) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "autodelete")) return;

  const rule = autodeleteRuleByChannel(loadAutodeleteConfig(guildConfig)).get(message.channel.id);
  if (!rule) return;

  const guildId = message.guild.id;
  const channelId = message.channel.id;

  setTimeout(() => {
    void (async () => {
      const latest = await configManager.getEffectiveConfig(guildId);
      if (!pluginEnabled(latest, "autodelete")) return;
      // Re-check the rule at delete-time too — if it was disabled or removed from the
      // dashboard while this message was waiting out its delay, leave the message alone.
      const latestRule = autodeleteRuleByChannel(loadAutodeleteConfig(latest)).get(channelId);
      if (!latestRule) return;
      await message.delete().catch(() => null);
    })();
  }, rule.delay_seconds * 1000);
}
