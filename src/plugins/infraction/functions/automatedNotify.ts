import type { ActionRowBuilder, Guild, MessageActionRowComponentBuilder, User } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { getLogger } from "../../../core/logger.js";
import { formatDurationShort } from "./duration.js";
import { buildNotifyMessage } from "./infractions.js";

const log = getLogger("infractions");

type NotifyKey = keyof InfractionConfig["notify"];

/**
 * Which of the server's Infractions DM settings covers a case type: timed punishments have their
 * own rows (tempmute/tempban), anything else falls back to the base type. Null when the type has no
 * DM setting (notes, unbans) or the server turned that DM off.
 */
export function automatedDmNotifyKey(type: string, notify: InfractionConfig["notify"]): NotifyKey | null {
  const key = (type in notify ? type : type.replace("temp", "")) as NotifyKey;
  if (!(key in notify)) return null;
  return notify[key]?.dm ? key : null;
}

/**
 * What a DM for an automated case would carry: the server's DM setting for that type (or null when
 * the server doesn't DM it) and the Appeal button, present only when the Appeals plugin is on,
 * accepting, has the DM button enabled and allows appeals for this case type.
 */
export async function planAutomatedDm(
  guildConfig: GuildConfig,
  guildId: string,
  record: { id: number; type: string },
): Promise<{ notifyKey: NotifyKey; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } | null> {
  const infractionConfig = getPluginSettings(guildConfig, "infractions") as InfractionConfig;
  const notifyKey = automatedDmNotifyKey(record.type, infractionConfig.notify);
  if (!notifyKey) return null;
  let components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  try {
    const { appealDmComponents } = await import("../../appeals/functions/links.js");
    components = appealDmComponents(guildConfig, guildId, record);
  } catch (error) {
    log.warn(`Appeal button lookup failed in ${guildId}: ${error instanceof Error ? error.message : error}`);
  }
  return { notifyKey, components };
}

/**
 * DMs the member about a case an automated system (Incident Response, Scam Protect, Impersonation
 * Detection, Global Watchdog) created, exactly like a moderator's case: the server's Infractions DM
 * setting and template for that type decide whether and what to send, and the Appeal button is added
 * when Appeals allows it. Only current members get DMs, so call this BEFORE a kick or ban.
 * Best-effort: returns false when nothing was sent, never throws.
 */
export async function dmAutomatedCase(options: {
  guild: Guild;
  guildConfig: GuildConfig;
  user: User;
  record: { id: number; type: string; expiresAt?: Date | null };
  reason: string;
  /** Shown as `{mod}` in the server's DM template, e.g. "Incident Response". */
  actorLabel: string;
}): Promise<boolean> {
  const { guild, guildConfig, user, record, reason, actorLabel } = options;
  try {
    if (user.bot) return false;
    const plan = await planAutomatedDm(guildConfig, guild.id, record);
    if (!plan) return false;
    if (!(await guild.members.fetch(user.id).catch(() => null))) return false;

    const infractionConfig = getPluginSettings(guildConfig, "infractions") as InfractionConfig;
    let t: Parameters<typeof buildNotifyMessage>[3];
    try {
      const { translatorFor } = await import("../../../i18n/index.js");
      t = (await translatorFor(user.id)).t;
    } catch {
      t = undefined;
    }
    const message = buildNotifyMessage(
      infractionConfig,
      plan.notifyKey,
      {
        action: record.type,
        guild: guild.name,
        reason,
        mod: actorLabel,
        expires: record.expiresAt ? formatDurationShort(record.expiresAt.getTime() - Date.now()) : "",
      },
      t,
    );
    if (!message) return false;
    await user.send(plan.components.length > 0 ? { content: message, components: plan.components } : message);
    return true;
  } catch {
    return false;
  }
}
