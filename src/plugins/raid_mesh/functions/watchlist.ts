import type { Client, GuildMember } from "discord.js";
import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { raidMeshLinks, raidMeshWatchlist } from "../../../db/schema.js";
import type { RaidMeshConfig } from "../../../config/schemas/raidMesh.js";
import { buildGenericServerLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { getLogger } from "../../../core/logger.js";
import { MESH_WATCHLIST_SIGNAL_WEIGHT } from "../../incident_response/functions/weights.js";
import { isWatchlistEntryLive, watchlistExpiry, watchlistUserIds } from "./watchlistRules.js";

const log = getLogger("raid_mesh");

function watchlistSettings(config: RaidMeshConfig): { enabled: boolean; hours: number } {
  return { enabled: config.watchlist?.enabled !== false, hours: config.watchlist?.hours ?? 24 };
}

/**
 * Remembers the accounts named in a mesh alert `guildId` just received from `source`, for the
 * receiving server's watch window. A repeat alert refreshes the entry. Only called for an
 * existing, mutual mesh link (see broadcastRaidAlert), with ids the alert card already shows.
 */
export async function rememberMeshAlertJoiners(
  guildId: string,
  config: RaidMeshConfig,
  source: { id: string; name: string },
  joiners: { id: string }[],
  now = Date.now(),
): Promise<number> {
  const settings = watchlistSettings(config);
  if (!settings.enabled) return 0;
  const ids = watchlistUserIds(joiners);
  if (ids.length === 0) return 0;
  const createdAt = new Date(now);
  const expiresAt = watchlistExpiry(now, settings.hours);
  await getDb()
    .insert(raidMeshWatchlist)
    .values(
      ids.map((userId) => ({
        guildId,
        userId,
        sourceGuildId: source.id,
        sourceGuildName: source.name.slice(0, 100),
        createdAt,
        expiresAt,
      })),
    )
    .onConflictDoUpdate({
      target: [raidMeshWatchlist.guildId, raidMeshWatchlist.userId],
      set: { sourceGuildId: source.id, sourceGuildName: source.name.slice(0, 100), createdAt, expiresAt },
    });
  return ids.length;
}

/** Deletes every expired watchlist entry. Run hourly from the raid_mesh plugin's interval. */
export async function sweepExpiredWatchlist(now = Date.now()): Promise<number> {
  const deleted = await getDb()
    .delete(raidMeshWatchlist)
    .where(lte(raidMeshWatchlist.expiresAt, new Date(now)))
    .returning({ userId: raidMeshWatchlist.userId });
  return deleted.length;
}

/** The live watchlist entry for a member, pruning it on read if it has expired. */
export async function getLiveWatchlistEntry(
  guildId: string,
  userId: string,
  now = Date.now(),
): Promise<typeof raidMeshWatchlist.$inferSelect | null> {
  const db = getDb();
  const where = and(eq(raidMeshWatchlist.guildId, guildId), eq(raidMeshWatchlist.userId, userId));
  const row = await db.select().from(raidMeshWatchlist).where(where).get();
  if (!row) return null;
  if (!isWatchlistEntryLive(row, now)) {
    await db.delete(raidMeshWatchlist).where(where);
    return null;
  }
  return row;
}

/** Drops this guild's watchlist entries that came from a server it just unlinked from. */
export async function forgetWatchlistFrom(guildId: string, sourceGuildId: string): Promise<void> {
  await getDb()
    .delete(raidMeshWatchlist)
    .where(and(eq(raidMeshWatchlist.guildId, guildId), eq(raidMeshWatchlist.sourceGuildId, sourceGuildId)));
}

async function stillLinked(guildId: string, otherGuildId: string): Promise<boolean> {
  const row = await getDb()
    .select({ guildId: raidMeshLinks.guildId })
    .from(raidMeshLinks)
    .where(and(eq(raidMeshLinks.guildId, guildId), eq(raidMeshLinks.linkedGuildId, otherGuildId)))
    .get();
  return Boolean(row);
}

/**
 * GuildMemberAdd: when someone named in a recent mesh alert joins, post a note in the mesh alert
 * channel and raise an Incident Response signal. The entry is consumed so one join flags once.
 */
export async function handleWatchlistMemberAdd(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const { configManager } = await import("../../../config/manager.js");
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!pluginEnabled(guildConfig, "raid_mesh")) return;
  const config = getPluginSettings(guildConfig, "raid_mesh") as RaidMeshConfig;
  if (!watchlistSettings(config).enabled) return;

  const entry = await getLiveWatchlistEntry(member.guild.id, member.id);
  if (!entry) return;
  // The link may have been removed since the alert; then the shared ids no longer apply here.
  if (!(await stillLinked(member.guild.id, entry.sourceGuildId))) {
    await forgetWatchlistFrom(member.guild.id, entry.sourceGuildId).catch(() => null);
    return;
  }
  await getDb()
    .delete(raidMeshWatchlist)
    .where(and(eq(raidMeshWatchlist.guildId, member.guild.id), eq(raidMeshWatchlist.userId, member.id)));

  const client: Client = member.client;
  const alertedAt = Math.floor(entry.createdAt.getTime() / 1000);
  await sendModerationLog(
    client,
    guildConfig,
    buildGenericServerLog(
      "Raid Defense Mesh Watchlist Join",
      [
        `Member: ${member} \`${member.user.username}\` (\`${member.id}\`)`,
        `Named in a mesh alert from **${entry.sourceGuildName}** <t:${alertedAt}:R>.`,
        "They just joined this server. Consider watching them closely.",
      ],
      member.user.displayAvatarURL({ size: 64 }),
      "modSevere",
    ),
    {
      guildId: member.guild.id,
      eventType: "raid_mesh",
      actorId: client.user?.id ?? null,
      targetId: member.id,
      caseLogOverride: config.alert_channel_id,
    },
  ).catch(() => null);

  try {
    const { reportSignal } = await import("../../incident_response/functions/signalBus.js");
    await reportSignal(client, {
      guildId: member.guild.id,
      source: "mesh_watchlist",
      signalType: "mesh_watchlist_join",
      weight: MESH_WATCHLIST_SIGNAL_WEIGHT,
      entityType: "user",
      entityId: member.id,
      entityLabel: `<@${member.id}>`,
      reason: `Named in a Raid Defense Mesh alert from ${entry.sourceGuildName}, then joined`,
    });
  } catch (error) {
    log.error("Incident Response signal (mesh watchlist) failed:", error);
  }
}
