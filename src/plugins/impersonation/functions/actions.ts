import { PermissionFlagsBits, type Client, type Guild, type GuildMember, type User } from "discord.js";
import type { ImpersonationConfig } from "../../../config/schemas/impersonation.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import {
  applyTimeout,
  clampTimeoutMs,
  createInfraction,
  postCaseLog,
} from "../../infraction/functions/infractions.js";
import { formatReason } from "../../infraction/functions/moderation.js";
import { dmAutomatedCase } from "../../infraction/functions/automatedNotify.js";
import type { ImpersonationMatch } from "./detect.js";

/** Runs the guild's configured `auto_action` against a flagged member, best-effort — a
 * missing bot permission or a failed API call is swallowed (still logged) rather than
 * blocking the alert itself from being recorded. Returns a short label for the alert row. */
export async function applyAutoAction(options: {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  config: ImpersonationConfig;
  member: GuildMember | null;
  user: User;
  match: ImpersonationMatch;
}): Promise<string | null> {
  const { client, guild, guildConfig, config, member, user, match } = options;
  if (config.auto_action === "none") return null;

  const reason = formatReason(
    `Impersonation Detection: looks like "${match.protectedIdentity.label}"` +
      (match.nameSimilarity ? ` (name ${match.nameSimilarity}% match)` : "") +
      (match.avatarDistance !== null ? ` (avatar distance ${match.avatarDistance})` : ""),
  );
  const infractionConfig = getPluginSettings(guildConfig, "infractions") as InfractionConfig;
  const modId = client.user!.id;
  const metadata = {
    source: "impersonation",
    matchedUserId: match.protectedIdentity.userId,
    matchedWatchlistId: match.protectedIdentity.watchlistId,
    nameSimilarity: match.nameSimilarity,
    avatarDistance: match.avatarDistance,
  };
  // Same DM a moderator's case sends (server's Infractions DM settings, plus the Appeal button when
  // Appeals allows it). Kicks and bans DM first, while the bot still shares the server.
  const notify = (record: { id: number; type: string; expiresAt?: Date | null }) =>
    dmAutomatedCase({ guild, guildConfig, user, record, reason, actorLabel: "Impersonation Detection" });

  if (config.auto_action === "timeout") {
    const durationMs = clampTimeoutMs(config.auto_action_duration_ms && config.auto_action_duration_ms > 0 ? config.auto_action_duration_ms : 3_600_000);
    if (member) await applyTimeout(member, durationMs, reason).catch(() => null);
    const record = await createInfraction({
      guildId: guild.id,
      userId: user.id,
      modId,
      type: "tempmute",
      reason,
      active: true,
      expiresAt: new Date(Date.now() + durationMs),
      metadata,
    });
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user, {
      durationLabel: `${Math.round(durationMs / 60_000)}m`,
    }).catch(() => null);
    await notify(record);
    return `timeout #${record.id}`;
  }

  if (config.auto_action === "kick") {
    const record = await createInfraction({
      guildId: guild.id,
      userId: user.id,
      modId,
      type: "kick",
      reason,
      active: false,
      metadata,
    });
    await notify(record);
    if (member?.kickable) await member.kick(reason).catch(() => null);
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
    return `kick #${record.id}`;
  }

  if (config.auto_action === "ban") {
    const record = await createInfraction({
      guildId: guild.id,
      userId: user.id,
      modId,
      type: "ban",
      reason,
      active: true,
      metadata,
    });
    await notify(record);
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      await guild.members.ban(user.id, { reason }).catch(() => null);
    }
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
    return `ban #${record.id}`;
  }

  return null;
}
