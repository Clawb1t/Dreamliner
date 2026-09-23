import type { Client } from "discord.js";
import { eq } from "drizzle-orm";
import { configManager } from "../../../config/manager.js";
import { isDreamlinerOneActive } from "../../../bridge/dreamlinerOne.js";
import {
  FREE_IMAGE_DAILY_SENDS,
  resolveMaxDailySends,
  zImagesConfig,
  type ImageDailySend,
} from "../../../config/schemas/images.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { getLogger } from "../../../core/logger.js";
import { getDb } from "../../../db/client.js";
import { imageDailySends } from "../../../db/schema.js";
import { fetchImage, IMAGE_SOURCE_LABELS } from "./sources.js";
import { imagePayload } from "./render.js";

const log = getLogger("images");

/** A send still fires if the bot was down (or the tick was late) at its exact minute, up to this long after. */
const CATCH_UP_MINUTES = 15;

let running = false;

function localNow(timeZone: string, now: Date): { date: string; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      minutes: Number(get("hour")) * 60 + Number(get("minute")),
    };
  } catch {
    return null;
  }
}

function targetMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** The local date this send is due for right now, or null if it isn't inside its send window. */
function dueDate(send: ImageDailySend, now: Date): string | null {
  const local = localNow(send.timezone, now);
  if (!local) return null;
  const late = local.minutes - targetMinutes(send.time);
  return late >= 0 && late <= CATCH_UP_MINUTES ? local.date : null;
}

async function postDailySend(client: Client, guildId: string, send: ImageDailySend): Promise<void> {
  const channel = await client.channels.fetch(send.channel_id).catch(() => null);
  // The channel id comes from guild config, so never post outside the guild that configured it.
  if (!channel || channel.isDMBased() || channel.guildId !== guildId || !channel.isSendable()) {
    throw new Error(`channel ${send.channel_id} is missing or not sendable`);
  }

  const image = await fetchImage(send.source).catch(() => fetchImage(send.source));
  await channel.send(imagePayload(send.source, `Daily ${IMAGE_SOURCE_LABELS[send.source]}`, image));
}

export async function runDailyImageSends(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const db = getDb();
    const now = new Date();

    for (const guild of client.guilds.cache.values()) {
      const guildConfig = await configManager.getEffectiveConfig(guild.id).catch(() => null);
      if (!guildConfig || !pluginEnabled(guildConfig, "images")) continue;

      const config = parsePluginConfig(zImagesConfig, getPluginSettings(guildConfig, "images"));
      // Sends past the free cap stay in config (so they come back if One is renewed) but only run with One.
      const limit =
        config.daily.length > FREE_IMAGE_DAILY_SENDS
          ? resolveMaxDailySends(await isDreamlinerOneActive(guild.id).catch(() => false))
          : FREE_IMAGE_DAILY_SENDS;
      const due = config.daily
        .slice(0, limit)
        .filter((send) => send.enabled && send.channel_id)
        .map((send) => ({ send, date: dueDate(send, now) }))
        .filter((entry): entry is { send: ImageDailySend; date: string } => entry.date !== null);
      if (!due.length) continue;

      const state = new Map(
        db
          .select()
          .from(imageDailySends)
          .where(eq(imageDailySends.guildId, guild.id))
          .all()
          .map((row) => [row.sendId, row.lastSentDate]),
      );

      for (const { send, date } of due) {
        if (state.get(send.id) === date) continue;
        // Mark before sending: a failed post skips today rather than retrying every minute for the
        // rest of the catch-up window (postDailySend already retries the image fetch once).
        db.insert(imageDailySends)
          .values({ guildId: guild.id, sendId: send.id, lastSentDate: date, lastSentAt: now })
          .onConflictDoUpdate({
            target: [imageDailySends.guildId, imageDailySends.sendId],
            set: { lastSentDate: date, lastSentAt: now },
          })
          .run();

        await postDailySend(client, guild.id, send).catch((err) => {
          log.warn(`Daily image send ${guild.id}#${send.id} failed:`, err);
        });
      }
    }
  } finally {
    running = false;
  }
}

