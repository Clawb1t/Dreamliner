import type { GuildMember } from "discord.js";
import { PermissionFlagsBits } from "discord.js";

/**
 * Whether `actor` may act on `target` (voice move/disconnect, nickname change, etc.) — mirrors
 * `infraction/functions/moderation.ts`'s `canModerateTarget`: Discord's own role hierarchy decides
 * this now (no more numeric permission level), plus the server owner always wins and nobody but
 * an Administrator can act on another Administrator. Whether the actor may run the command at all
 * is already gated upstream via the relevant `can_*` permission, so there's no extra floor here.
 */
export function canActOn(actor: GuildMember, target: GuildMember): boolean {
  if (actor.id === target.id) return true;
  if (target.id === target.guild.ownerId) return false;
  if (actor.id === actor.guild.ownerId) return true;

  if (target.roles.highest.position >= actor.roles.highest.position) return false;

  if (target.permissions.has(PermissionFlagsBits.Administrator) && !actor.permissions.has(PermissionFlagsBits.Administrator)) {
    return false;
  }

  return true;
}

export function findVoiceChannelByName(guild: import("discord.js").Guild, name: string) {
  const lower = name.toLowerCase();
  return guild.channels.cache.find(
    (c) => c.isVoiceBased() && c.name.toLowerCase().includes(lower),
  ) ?? null;
}
