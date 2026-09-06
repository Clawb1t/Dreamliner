import { randomBytes } from "node:crypto";
import type { Client } from "discord.js";
import { and, eq, lt, or } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { raidMeshInvites, raidMeshLinks } from "../../../db/schema.js";
import { buildRaidMeshAlertLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import type { RaidMeshConfig } from "../../../config/schemas/raidMesh.js";
import type { RaidJoinRecord } from "../../automod/functions/detectors/index.js";

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JOINERS_SHARED = 15;

export type RaidMeshLinkedGuild = { id: string; name: string; icon: string | null };

function generateCode(): string {
  return randomBytes(5).toString("base64url");
}

export async function createInvite(guildId: string, createdBy: string): Promise<{ code: string; expiresAt: string }> {
  const db = getDb();
  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await db.insert(raidMeshInvites).values({ code, guildId, createdBy, createdAt: now, expiresAt });
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function redeemInvite(
  code: string,
  redeemingGuildId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const invite = await db.select().from(raidMeshInvites).where(eq(raidMeshInvites.code, code)).get();
  if (!invite) return { ok: false, error: "That invite code doesn't exist or was already used." };
  if (invite.expiresAt.getTime() < Date.now()) {
    await db.delete(raidMeshInvites).where(eq(raidMeshInvites.code, code));
    return { ok: false, error: "That invite code has expired." };
  }
  if (invite.guildId === redeemingGuildId) {
    return { ok: false, error: "A server can't link with itself." };
  }

  const now = new Date();
  await db
    .insert(raidMeshLinks)
    .values([
      { guildId: invite.guildId, linkedGuildId: redeemingGuildId, linkedAt: now },
      { guildId: redeemingGuildId, linkedGuildId: invite.guildId, linkedAt: now },
    ])
    .onConflictDoNothing();
  await db.delete(raidMeshInvites).where(eq(raidMeshInvites.code, code));
  return { ok: true };
}

export async function listLinkedGuildIds(guildId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ linkedGuildId: raidMeshLinks.linkedGuildId })
    .from(raidMeshLinks)
    .where(eq(raidMeshLinks.guildId, guildId))
    .all();
  return rows.map((r) => r.linkedGuildId);
}

export async function unlink(guildId: string, otherGuildId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(raidMeshLinks)
    .where(
      or(
        and(eq(raidMeshLinks.guildId, guildId), eq(raidMeshLinks.linkedGuildId, otherGuildId)),
        and(eq(raidMeshLinks.guildId, otherGuildId), eq(raidMeshLinks.linkedGuildId, guildId)),
      ),
    );
}

/** Deletes invites past their TTL. Called periodically, see src/plugins/raid_mesh/index.ts. */
export async function sweepExpiredInvites(): Promise<number> {
  const db = getDb();
  const deleted = await db
    .delete(raidMeshInvites)
    .where(lt(raidMeshInvites.expiresAt, new Date()))
    .returning({ code: raidMeshInvites.code });
  return deleted.length;
}

/**
 * When `guildId`'s own raid detector trips, alert every server it's mutually linked with (via
 * a mesh invite both sides acted on) whose own Raid Defense Mesh is currently enabled, naming
 * the accounts involved in the burst so their staff can pre-emptively watch/ban them. Never
 * fires on its own, only in reaction to an already-detected raid.
 */
export async function broadcastRaidAlert(
  client: Client,
  guildId: string,
  input: { joinCount: number; windowMs: number; joiners: RaidJoinRecord[] },
): Promise<void> {
  const sourceGuild = client.guilds.cache.get(guildId);
  if (!sourceGuild) return;

  const { configManager } = await import("../../../config/manager.js");
  const sourceConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(sourceConfig, "raid_mesh")) return;

  const linkedIds = await listLinkedGuildIds(guildId);
  if (linkedIds.length === 0) return;

  const joiners = input.joiners.slice(0, MAX_JOINERS_SHARED).map((j) => ({ id: j.id, username: j.username }));

  for (const linkedGuildId of linkedIds) {
    const linkedGuild = client.guilds.cache.get(linkedGuildId);
    if (!linkedGuild) continue;
    const linkedConfig = await configManager.getEffectiveConfig(linkedGuildId);
    if (!pluginEnabled(linkedConfig, "raid_mesh")) continue;
    const raidMeshConfig = getPluginSettings(linkedConfig, "raid_mesh") as RaidMeshConfig;

    await sendModerationLog(
      client,
      linkedConfig,
      buildRaidMeshAlertLog({
        sourceGuildName: sourceGuild.name,
        joinCount: input.joinCount,
        windowMs: input.windowMs,
        joiners,
      }),
      {
        guildId: linkedGuildId,
        eventType: "raid_mesh",
        actorId: client.user!.id,
        caseLogOverride: raidMeshConfig.alert_channel_id,
      },
    ).catch(() => null);
  }
}

export async function getLinkedGuilds(client: Client, guildId: string): Promise<RaidMeshLinkedGuild[]> {
  const ids = await listLinkedGuildIds(guildId);
  const guilds: RaidMeshLinkedGuild[] = [];
  for (const id of ids) {
    const guild = client.guilds.cache.get(id);
    guilds.push(guild ? { id, name: guild.name, icon: guild.iconURL({ size: 64 }) } : { id, name: id, icon: null });
  }
  return guilds;
}
