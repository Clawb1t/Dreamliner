import type { Client, MessageReaction, User } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { safeAddRole, safeRemoveRole } from "../../../core/roles.js";
import { findReactionRoleMappingByReaction } from "./store.js";

export async function handleReactionRole(
  _client: Client,
  reaction: MessageReaction,
  user: User,
  action: "add" | "remove",
): Promise<void> {
  if (user.bot) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const message = reaction.message;
  if (!message.guild) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "reaction_roles")) return;

  const mapping = await findReactionRoleMappingByReaction(message.guild.id, message.id, reaction.emoji);
  if (!mapping) return;

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  if (action === "add") {
    await safeAddRole(member, mapping.roleId, "Reaction role");
    return;
  }

  if (mapping.removeOnUnreact) {
    await safeRemoveRole(member, mapping.roleId, "Reaction role removed");
  }
}
