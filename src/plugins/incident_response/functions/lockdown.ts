import { PermissionFlagsBits, type Guild, type NonThreadGuildBasedChannel } from "discord.js";
import { and, eq, isNull, lte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { incidentLockdowns } from "../../../db/schema.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("incident_response");

type PreviousOverwrite = "allow" | "deny" | "inherit";

function readPreviousOverwrite(channel: NonThreadGuildBasedChannel, everyoneRoleId: string): PreviousOverwrite {
  const overwrite = channel.permissionOverwrites.cache.get(everyoneRoleId);
  if (!overwrite) return "inherit";
  if (overwrite.deny.has(PermissionFlagsBits.SendMessages)) return "deny";
  if (overwrite.allow.has(PermissionFlagsBits.SendMessages)) return "allow";
  return "inherit";
}

function isLockable(channel: unknown): channel is NonThreadGuildBasedChannel {
  return (
    !!channel &&
    typeof channel === "object" &&
    "permissionOverwrites" in channel &&
    "guild" in channel &&
    typeof (channel as NonThreadGuildBasedChannel).isTextBased === "function" &&
    (channel as NonThreadGuildBasedChannel).isTextBased()
  );
}

/** Denies SendMessages (+thread creation) for @everyone in one channel, recording the exact
 * prior state so `unlockChannel` can restore it instead of guessing. No-ops (returns null)
 * if the channel is already locked by an open Incident Response lockdown row. */
export async function lockChannel(
  channel: NonThreadGuildBasedChannel,
  opts: { incidentId?: number | null; lockedBy: string; unlockAfterMs?: number },
): Promise<number | null> {
  const guild = channel.guild;
  const everyoneId = guild.roles.everyone.id;

  const existing = await getDb()
    .select()
    .from(incidentLockdowns)
    .where(and(eq(incidentLockdowns.guildId, guild.id), eq(incidentLockdowns.channelId, channel.id), isNull(incidentLockdowns.unlockedAt)))
    .get();
  if (existing) return existing.id;

  const previousOverwrite = readPreviousOverwrite(channel, everyoneId);

  try {
    await channel.permissionOverwrites.edit(everyoneId, {
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    });
  } catch (err) {
    log.error(`[incident_response] failed to lock channel ${channel.id}:`, err);
    return null;
  }

  const now = new Date();
  const row = await getDb()
    .insert(incidentLockdowns)
    .values({
      guildId: guild.id,
      channelId: channel.id,
      incidentId: opts.incidentId ?? null,
      previousOverwrite,
      lockedAt: now,
      lockedBy: opts.lockedBy,
      unlockAt: opts.unlockAfterMs && opts.unlockAfterMs > 0 ? new Date(now.getTime() + opts.unlockAfterMs) : null,
    })
    .returning()
    .get();
  return row.id;
}

/** Locks every text-capable channel in the server, capped and staggered to avoid a rate-limit
 * storm. Best-effort per channel — one failure never stops the rest. */
export async function lockdownServer(
  guild: Guild,
  opts: { incidentId?: number | null; lockedBy: string; unlockAfterMs?: number },
): Promise<number> {
  const channels = [...guild.channels.cache.values()].filter(isLockable);
  const CONCURRENCY = 4;
  let locked = 0;
  for (let i = 0; i < channels.length; i += CONCURRENCY) {
    const batch = channels.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((ch) => lockChannel(ch, opts)));
    locked += results.filter((r) => r.status === "fulfilled" && r.value !== null).length;
  }
  return locked;
}

async function restoreOverwrite(channel: NonThreadGuildBasedChannel, everyoneId: string, previous: PreviousOverwrite): Promise<void> {
  if (previous === "inherit") {
    await channel.permissionOverwrites.edit(everyoneId, {
      SendMessages: null,
      CreatePublicThreads: null,
      CreatePrivateThreads: null,
    });
    return;
  }
  await channel.permissionOverwrites.edit(everyoneId, {
    SendMessages: previous === "allow",
  });
}

/** Reverses one lockdown row, restoring the channel's exact prior @everyone SendMessages
 * state. Safe to call even if the channel or lockdown row is gone. */
export async function unlockLockdownRow(
  guild: Guild,
  row: { id: number; channelId: string; previousOverwrite: string },
  unlockedBy: string,
): Promise<boolean> {
  const channel = guild.channels.cache.get(row.channelId);
  if (channel && isLockable(channel)) {
    try {
      await restoreOverwrite(channel, guild.roles.everyone.id, row.previousOverwrite as PreviousOverwrite);
    } catch (err) {
      log.error(`[incident_response] failed to unlock channel ${row.channelId}:`, err);
    }
  }
  await getDb()
    .update(incidentLockdowns)
    .set({ unlockedAt: new Date(), unlockedBy })
    .where(eq(incidentLockdowns.id, row.id));
  return true;
}

export async function unlockChannelManually(
  guild: Guild,
  channelId: string,
  unlockedBy: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await getDb()
    .select()
    .from(incidentLockdowns)
    .where(and(eq(incidentLockdowns.guildId, guild.id), eq(incidentLockdowns.channelId, channelId), isNull(incidentLockdowns.unlockedAt)))
    .get();
  if (!row) return { ok: false, error: "That channel isn't currently locked by Incident Response." };
  await unlockLockdownRow(guild, row, unlockedBy);
  return { ok: true };
}

/** Unlocks every lockdown row past its `unlockAt`. Called on an interval from the plugin's
 * `onLoad`, same shape as Passport's expiry sweep (`functions/timeout.ts`). */
export async function sweepExpiredLockdowns(
  resolveGuild: (guildId: string) => Guild | null,
): Promise<number> {
  const due = await getDb()
    .select()
    .from(incidentLockdowns)
    .where(and(isNull(incidentLockdowns.unlockedAt), lte(incidentLockdowns.unlockAt, new Date())));

  let unlocked = 0;
  for (const row of due) {
    if (!row.unlockAt) continue;
    const guild = resolveGuild(row.guildId);
    if (!guild) {
      await getDb().update(incidentLockdowns).set({ unlockedAt: new Date(), unlockedBy: "system" }).where(eq(incidentLockdowns.id, row.id));
      continue;
    }
    await unlockLockdownRow(guild, row, "system");
    unlocked++;
  }
  return unlocked;
}
