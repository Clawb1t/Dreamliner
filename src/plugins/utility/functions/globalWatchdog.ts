import { PermissionFlagsBits, type GuildMember } from "discord.js";
import { checkGlobalWatchdog } from "../../../bridge/globalWatchdog.js";
import { buildGlobalWatchdogHitLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import type { UtilityConfig } from "../../../config/schemas/utility.js";
import { createInfraction, postCaseLog } from "../../infraction/functions/infractions.js";
import { formatReason } from "../../infraction/functions/moderation.js";

/**
 * Checks a joining member against the platform-wide Global Watchdog list (superuser-curated,
 * see src/bridge/globalWatchdog.ts). No-ops unless this server has explicitly opted in via
 * `global_watchdog_action`. Never touches members who aren't on the list, this only ever acts
 * on already-confirmed bad actors, never ambient tracking of ordinary joiners.
 */
export async function handleGlobalWatchdogMemberAdd(member: GuildMember): Promise<void> {
  if (member.user.bot) return;

  const { configManager } = await import("../../../config/manager.js");
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);

  const utilityConfig = getPluginSettings(guildConfig, "utility") as UtilityConfig;
  const action = utilityConfig.global_watchdog_action;
  if (!action || action === "off") return;

  const entry = await checkGlobalWatchdog(member.id).catch(() => null);
  if (!entry) return;

  const { client, guild } = member;
  const reason = formatReason(`Global Watchdog: ${entry.reason}`);

  if (action === "kick" || action === "ban") {
    const infractionConfig = getPluginSettings(guildConfig, "infractions") as InfractionConfig;
    const modId = client.user!.id;

    if (action === "kick" && member.kickable) {
      await member.kick(reason).catch(() => null);
    } else if (action === "ban" && guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      await guild.members.ban(member.id, { reason }).catch(() => null);
    }

    const record = await createInfraction({
      guildId: guild.id,
      userId: member.id,
      modId,
      type: action,
      reason,
      active: action === "ban",
      metadata: { source: "global_watchdog", evidenceUrl: entry.evidenceUrl },
    });
    await postCaseLog(client, guildConfig, infractionConfig, record, member.user, client.user).catch(() => null);
  }

  await sendModerationLog(
    client,
    guildConfig,
    buildGlobalWatchdogHitLog({
      user: {
        id: member.id,
        name: member.user.username,
        avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      },
      reason: entry.reason,
      evidenceUrl: entry.evidenceUrl,
      action,
    }),
    {
      guildId: guild.id,
      eventType: "global_watchdog",
      actorId: client.user!.id,
      targetId: member.id,
    },
  );
}
