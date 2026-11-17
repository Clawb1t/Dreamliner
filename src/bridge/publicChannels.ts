import { PermissionFlagsBits, type Guild, type GuildBasedChannel } from "discord.js";
import { configManager } from "../config/manager.js";
import { getPassportConfig, isPassportEnabled } from "../plugins/passport/functions/loadConfig.js";

/**
 * Public pages (global stats, a server's public page) only name channels an ordinary member could
 * see: one @everyone can view, or one a Passport-verified member gets (Passport's granted roles).
 * Staff-only, private and hidden channels never appear there. Staff dashboards are unaffected.
 */

/** @everyone plus the roles Passport grants on verification (when Passport is on). */
export async function publicAudienceRoleIds(guild: Guild): Promise<string[]> {
  const ids = [guild.id];
  try {
    const config = await configManager.getEffectiveConfig(guild.id);
    if (isPassportEnabled(config)) {
      for (const id of getPassportConfig(config).grant_role_ids) {
        if (id.trim() && guild.roles.cache.has(id)) ids.push(id);
      }
    }
  } catch {
    /* fall back to @everyone only */
  }
  return ids;
}

/** True when any of the audience roles can view the channel (overwrites included). */
export function channelPubliclyVisible(channel: GuildBasedChannel, audienceRoleIds: string[]): boolean {
  for (const roleId of audienceRoleIds) {
    const role = channel.guild.roles.cache.get(roleId);
    if (!role) continue;
    try {
      if (channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel)) return true;
    } catch {
      /* treat unknown permissions as hidden */
    }
  }
  return false;
}

/** A per-call cache of each guild's audience, for pages that check channels from many guilds. */
export function publicChannelChecker(): (guild: Guild, channel: GuildBasedChannel) => Promise<boolean> {
  const audiences = new Map<string, Promise<string[]>>();
  return async (guild, channel) => {
    let audience = audiences.get(guild.id);
    if (!audience) {
      audience = publicAudienceRoleIds(guild);
      audiences.set(guild.id, audience);
    }
    return channelPubliclyVisible(channel, await audience);
  };
}
