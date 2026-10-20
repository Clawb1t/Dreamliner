import { PermissionFlagsBits, type Guild, type Role } from "discord.js";
import { getLogger } from "../../../core/logger.js";
import { setCharacterRole, type CharacterRecord } from "./store.js";

const log = getLogger("characters");

/**
 * Each character has a mentionable role so members can @mention it. Nobody is ever given the role,
 * and it has no permissions; it only exists to be mentioned.
 */

export function canManageRoles(guild: Guild): boolean {
  return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles));
}

/** The bot can only edit or delete roles below its own highest role. */
export function canEditRole(guild: Guild, role: Role): boolean {
  const me = guild.members.me;
  return Boolean(me && canManageRoles(guild) && role.comparePositionTo(me.roles.highest) < 0 && !role.managed);
}

export type EnsureRoleResult = { roleId: string | null; error: string | null };

/**
 * Makes sure the character's role exists (recreating it when it was deleted) and matches its name
 * and colour. Saves the role id on the character.
 */
export async function ensureCharacterRole(guild: Guild, character: CharacterRecord): Promise<EnsureRoleResult> {
  if (!canManageRoles(guild)) {
    return { roleId: null, error: "Dreamliner needs the Manage Roles permission to create the character's @role." };
  }
  const existing = character.roleId
    ? guild.roles.cache.get(character.roleId) ?? (await guild.roles.fetch(character.roleId).catch(() => null))
    : null;

  if (existing) {
    const color = character.roleColor ?? 0;
    const needsEdit = existing.name !== character.name || existing.colors.primaryColor !== color || !existing.mentionable;
    if (needsEdit && canEditRole(guild, existing)) {
      await existing
        .edit({ name: character.name, colors: { primaryColor: color }, mentionable: true, reason: "Dreamliner character updated" })
        .catch((err) => log.warn(`Couldn't update the role for character ${character.id} in ${guild.id}: ${err instanceof Error ? err.message : err}`));
    }
    return { roleId: existing.id, error: null };
  }

  try {
    const role = await guild.roles.create({
      name: character.name,
      ...(character.roleColor != null ? { colors: { primaryColor: character.roleColor } } : {}),
      permissions: [],
      mentionable: true,
      hoist: false,
      reason: `Role for the Dreamliner character ${character.name}`,
    });
    setCharacterRole(guild.id, character.id, role.id);
    return { roleId: role.id, error: null };
  } catch (err) {
    log.warn(`Couldn't create the role for character ${character.id} in ${guild.id}: ${err instanceof Error ? err.message : err}`);
    if (character.roleId) setCharacterRole(guild.id, character.id, null);
    return { roleId: null, error: "Discord didn't let Dreamliner create the character's role." };
  }
}

/** Deletes a character's role when the bot is able to. */
export async function deleteCharacterRole(guild: Guild, roleId: string | null): Promise<void> {
  if (!roleId) return;
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role || !canEditRole(guild, role)) return;
  await role.delete("Dreamliner character deleted").catch(() => null);
}
