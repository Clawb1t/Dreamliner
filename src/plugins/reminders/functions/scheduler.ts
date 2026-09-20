import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getDueReminders, removeReminder } from "./store.js";
import { getLogger } from "../../../core/logger.js";
import { translatorFor } from "../../../i18n/index.js";
import { baseEmbed } from "../../../core/embeds.js";
import { containerReply, pingComponent } from "../../../core/responses.js";
const log = getLogger("reminders");

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
      const { t } = await translatorFor(reminder.userId);
      const embed = baseEmbed()
        .setTitle(t("reminders.deliver.title", "Reminder"))
        .setDescription(reminder.message);
      const payload = containerReply(embed);

      const dmSent = user
        ? await user.send(payload).then(() => true).catch(() => false)
        : false;

      if (!dmSent) {
        const channel = await guild.channels.fetch(reminder.channelId).catch(() => null);
        if (channel?.isTextBased() && "send" in channel) {
          // Ping only the reminder's owner — never let a reminder body containing
          // "@everyone"/"@here" (or anyone else's mention) actually notify them.
          await channel.send({
            ...payload,
            components: [pingComponent(`<@${reminder.userId}>`), ...payload.components],
            allowedMentions: { users: [reminder.userId] },
          });
        }
      }
    } catch (err) {
      log.error(`Failed to deliver reminder #${reminder.id}:`, err);
    } finally {
      const guildConfig = await configManager.getEffectiveConfig(reminder.guildId).catch(() => null);
      if (!guildConfig || pluginEnabled(guildConfig, "reminders")) {
        await removeReminder(reminder.id);
      }
    }
  }
}
