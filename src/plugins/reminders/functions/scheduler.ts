import type { Client } from "discord.js";
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
      await removeReminder(reminder.id);
    }
  }
}
