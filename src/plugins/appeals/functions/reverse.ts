import type { Client, Guild } from "discord.js";
import { zInfractionConfig } from "../../../config/schemas/infraction.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import {
  postCaseLog,
  setInfractionActive,
  unbanUser,
  unmuteUser,
} from "../../infraction/functions/infractions.js";
import type { AppealRecord } from "./store.js";

export type ReversalResult = { ok: boolean; note: string; unbanned: boolean };

/** Discord's "Missing Permissions" error, worded for the reviewer. */
function failure(action: string, error: unknown): ReversalResult {
  const code = error && typeof error === "object" && "code" in error ? Number((error as { code: unknown }).code) : 0;
  const why =
    code === 50013
      ? "I'm missing the permission for it, or their role is above mine."
      : error instanceof Error
        ? error.message
        : "Discord refused.";
  return { ok: false, note: `Couldn't ${action}: ${why}`, unbanned: false };
}

/**
 * Lifts what an approved appeal was about: unbans (bans, tempbans, and manual appeals by banned
 * users), removes the timeout (mutes), or revokes the case (warnings, kicks, softbans). Every
 * change is recorded as a case and logged like a moderator did it. Never throws.
 */
export async function reversePunishment(
  client: Client,
  guild: Guild,
  guildConfig: GuildConfig,
  appeal: AppealRecord,
  reviewerId: string,
): Promise<ReversalResult> {
  const reason = `Appeal #${appeal.id} approved`;
  const infractionConfig = parsePluginConfig(zInfractionConfig, getPluginSettings(guildConfig, "infractions"));
  const user = await client.users.fetch(appeal.userId).catch(() => null);
  const reviewer = await client.users.fetch(reviewerId).catch(() => null);
  const type = appeal.infractionType ?? "";

  const lift = async (action: "unban" | "unmute"): Promise<ReversalResult> => {
    try {
      const record =
        action === "unban"
          ? await unbanUser(guild, appeal.userId, reviewerId, reason)
          : await unmuteUser(guild, appeal.userId, reviewerId, reason);
      await postCaseLog(client, guildConfig, infractionConfig, record, user, reviewer).catch(() => null);
      return { ok: true, note: action === "unban" ? "Unbanned" : "Mute lifted", unbanned: action === "unban" };
    } catch (error) {
      return failure(action, error);
    }
  };

  // The server's own options only touch Discord when they were set to lift a ban (stored as "ban").
  if (appeal.option && type !== "ban") return { ok: true, note: "Nothing to lift on Discord", unbanned: false };

  if (type === "ban" || type === "tempban" || appeal.kind === "manual") {
    const banned = await guild.bans.fetch({ user: appeal.userId, force: true }).catch(() => null);
    if (banned) return lift("unban");
    if (appeal.caseId) await setInfractionActive(guild.id, appeal.caseId, false);
    return { ok: true, note: appeal.kind === "manual" ? "Nothing to lift (not banned)" : "Already unbanned", unbanned: false };
  }

  if (type === "mute" || type === "tempmute") return lift("unmute");

  // Warnings, kicks and softbans have nothing ongoing to undo: the case itself is revoked.
  if (appeal.caseId) await setInfractionActive(guild.id, appeal.caseId, false);
  const label = type === "warn" ? "Warning revoked" : type === "kick" ? "Kick revoked" : "Case revoked";
  return { ok: true, note: label, unbanned: false };
}
