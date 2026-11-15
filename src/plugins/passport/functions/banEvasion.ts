import type { Client, GuildMember } from "discord.js";
import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { modCases } from "../../../db/schema.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { PassportConfig } from "../../../config/schemas/passport.js";
import { buildGenericServerLog } from "../../../core/logging/format.js";
import { emitLog } from "../../../core/logging/send.js";
import { getLogger } from "../../../core/logger.js";
import { BAN_EVASION_SIGNAL_WEIGHTS } from "../../incident_response/functions/weights.js";
import { banEvasionMatches, directAltLinks, type BanEvasionMatch } from "./altMatching.js";
import { listPassportAltDismissals, listPassportNetworkSignals } from "./altSignals.js";

const log = getLogger("passport");
const BAN_TYPES = ["ban", "tempban"];
/** One alert per member/banned-account pair per day, so a re-verify doesn't re-alert. */
const ALERT_COOLDOWN_MS = 24 * 3_600_000;
const recentAlerts = new Map<string, number>();

/** Whether ban-evasion alerts run for this server's Passport config. */
export function banEvasionAlertsOn(config: PassportConfig): boolean {
  return config.alt_detection && config.alt_ban_evasion_alerts !== false;
}

/** Active ban cases in this guild for any of `userIds`, newest case per account. */
export async function activeBansFor(
  guildId: string,
  userIds: string[],
): Promise<Map<string, { caseId: number; type: string }>> {
  const bans = new Map<string, { caseId: number; type: string }>();
  if (userIds.length === 0) return bans;
  const rows = await getDb()
    .select({ id: modCases.id, userId: modCases.userId, type: modCases.type })
    .from(modCases)
    .where(
      and(
        eq(modCases.guildId, guildId),
        eq(modCases.active, true),
        inArray(modCases.userId, userIds.slice(0, 500)),
        or(...BAN_TYPES.map((type) => eq(modCases.type, type))),
      ),
    )
    .all();
  for (const row of rows) {
    const existing = bans.get(row.userId);
    if (!existing || row.id > existing.caseId) bans.set(row.userId, { caseId: row.id, type: row.type });
  }
  return bans;
}

function matchLabel(match: BanEvasionMatch): string {
  return match.tier === "high" ? "High (same network)" : "Medium (nearby network)";
}

/**
 * After a web Passport verification records its network signal: if the member is directly
 * linked (exact IP or same subnet, never city-only) to an account with an active ban in THIS
 * server, alert staff in the moderation log and raise an Incident Response signal. Per-guild data
 * only, and the alert never includes IPs or locations. Best-effort, never throws.
 */
export async function checkBanEvasion(options: {
  client: Client;
  member: GuildMember;
  guildConfig: GuildConfig;
  config: PassportConfig;
}): Promise<BanEvasionMatch[]> {
  const { client, member, guildConfig, config } = options;
  if (!banEvasionAlertsOn(config)) return [];
  const guildId = member.guild.id;
  try {
    const [rows, dismissals] = await Promise.all([listPassportNetworkSignals(guildId), listPassportAltDismissals(guildId)]);
    const links = directAltLinks(rows, dismissals, member.id);
    if (links.length === 0) return [];
    const bans = await activeBansFor(
      guildId,
      links.filter((l) => l.tier !== "low").map((l) => l.userId),
    );
    const now = Date.now();
    for (const [key, at] of recentAlerts) if (now - at > ALERT_COOLDOWN_MS) recentAlerts.delete(key);
    const matches = banEvasionMatches(links, bans).filter((m) => !recentAlerts.has(`${guildId}:${member.id}:${m.bannedUserId}`));
    if (matches.length === 0) return [];
    for (const m of matches) recentAlerts.set(`${guildId}:${member.id}:${m.bannedUserId}`, now);

    const top = matches[0]!;
    await emitLog(
      client,
      guildConfig,
      buildGenericServerLog(
        "Possible Ban Evasion",
        [
          `Member: ${member} \`${member.user.username}\` (\`${member.id}\`)`,
          ...matches.slice(0, 5).map(
            (m) => `Linked to: <@${m.bannedUserId}> (\`${m.bannedUserId}\`), active ${m.caseType} case **#${m.caseId}**. Match: ${matchLabel(m)}`,
          ),
          "Passport alt detection linked this newly verified member to a banned account. Review the Alts tab before acting.",
        ],
        member.user.displayAvatarURL({ size: 64 }),
        "modSevere",
      ),
      {
        guildId,
        eventType: "passport_ban_evasion",
        summary: `${member.user.tag} may be evading ban case #${top.caseId}.`,
        actorId: client.user?.id ?? null,
        targetId: member.id,
        caseId: top.caseId,
      },
    ).catch(() => null);

    try {
      const { reportSignal } = await import("../../incident_response/functions/signalBus.js");
      await reportSignal(client, {
        guildId,
        source: "ban_evasion",
        signalType: `ban_evasion_${top.tier}`,
        weight: BAN_EVASION_SIGNAL_WEIGHTS[top.tier],
        entityType: "user",
        entityId: member.id,
        entityLabel: `<@${member.id}>`,
        secondaryEntityType: "user",
        secondaryEntityId: top.bannedUserId,
        reason: `Passport linked them to a banned account (case #${top.caseId})`,
      });
    } catch (error) {
      log.error("Incident Response signal (ban evasion) failed:", error);
    }
    return matches;
  } catch (error) {
    log.warn(`Ban-evasion check failed in ${guildId}: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}
