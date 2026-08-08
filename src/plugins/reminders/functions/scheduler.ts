import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getDueReminders, removeReminder } from "./store.js";

export async function processDueReminders(client: Client): Promise<void> {
  const due = await getDueReminders();
  for (const reminder of due) {
    try {
      const guild = await client.guilds.fetch(reminder.guildId).catch(() => null);
      if (!guild) {
        await removeReminder(reminder.id);
        continue;
      }

      const guildConfig = await configManager.getEffectiveConfig(reminder.guildId);
      if (!pluginEnabled(guildConfig, "reminders")) {
        // Keep the row so it can deliver after the plugin is re-enabled.
        continue;
      }

      const user = await client.users.fetch(reminder.userId).catch(() => null);
      const content = `Reminder: ${reminder.message}`;

      const dmSent = user
        ? await user.send({ content }).then(() => true).catch(() => false)
        : false;

      if (!dmSent) {
        const channel = await guild.channels.fetch(reminder.channelId).catch(() => null);
        if (channel?.isTextBased() && "send" in channel) {
          await channel.send({ content: `<@${reminder.userId}> ${content}` });
        }
      }
    } catch (err) {
      console.error(`Failed to deliver reminder #${reminder.id}:`, err);
    } finally {
      const guildConfig = await configManager.getEffectiveConfig(reminder.guildId).catch(() => null);
      if (!guildConfig || pluginEnabled(guildConfig, "reminders")) {
        await removeReminder(reminder.id);
      }
    }
  }
}
