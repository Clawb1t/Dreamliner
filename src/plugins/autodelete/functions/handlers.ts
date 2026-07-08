import type { Message } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getAutodeleteRule } from "./store.js";

export async function handleAutodeleteMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || !message.channel.isTextBased()) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "autodelete")) return;

  const rule = await getAutodeleteRule(message.guild.id, message.channel.id);
  if (!rule) return;

  setTimeout(() => {
    message.delete().catch(() => null);
  }, rule.delaySeconds * 1000);
}
