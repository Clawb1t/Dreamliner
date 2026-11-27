import type { Client } from "discord.js";
import { APPLICATION_EMOJIS } from "../../../config/schemas/applications.js";
import { configManager } from "../../../config/manager.js";
import { baseEmbed, setEmbedAuthor } from "../../../core/embeds.js";
import { getLogger } from "../../../core/logger.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { containerReply } from "../../../core/responses.js";
import { findOpening, loadApplicationsConfig, openingName, PLUGIN } from "./config.js";
import { reminderDue } from "./formLogic.js";
import { claimReminder, goingResponses, rsvpFormsWithAttendees } from "./store.js";

const log = getLogger("applications");

/** How often RSVP reminders are checked. Cheap: one indexed query, then only forms with people going. */
export const REMINDER_INTERVAL_MS = 5 * 60_000;

/**
 * DMs everyone going to an RSVP form shortly before it starts (the form's `reminder_minutes`).
 * Each event start is claimed once in `form_reminders`, so restarts never send it twice.
 */
export async function sendDueRsvpReminders(client: Client): Promise<number> {
  let sent = 0;
  const now = Date.now();
  for (const { guildId, openingId } of rsvpFormsWithAttendees()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
    if (!guildConfig || !pluginEnabled(guildConfig, PLUGIN)) continue;
    const opening = findOpening(loadApplicationsConfig(guildConfig), openingId);
    if (!opening || !reminderDue(opening, now) || !opening.event.starts_at) continue;
    if (!claimReminder(guildId, openingId, opening.event.starts_at)) continue;
    const start = Math.floor(Date.parse(opening.event.starts_at) / 1000);
    const location = opening.event.location.trim();
    for (const response of goingResponses(guildId, openingId)) {
      if (response.anonymous) continue;
      const user = await client.users.fetch(response.userId).catch(() => null);
      if (!user) continue;
      const container = setEmbedAuthor(baseEmbed(), "Starting soon", client, {
        emoji: APPLICATION_EMOJIS.pending,
        thumbnailURL: guild.iconURL({ size: 128 }),
      })
        .setDescription(
          [`**${openingName(opening)}** in **${guild.name}** starts <t:${start}:R> (<t:${start}:t>).`, location ? `Where: ${location}` : ""]
            .filter(Boolean)
            .join("\n"),
        )
        .setFooter({ text: guild.name });
      if (await user.send(containerReply(container)).then(() => true).catch(() => false)) sent++;
    }
    log.info(`[applications] Sent RSVP reminders for ${openingId} in ${guildId}`);
  }
  return sent;
}
