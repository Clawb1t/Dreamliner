import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import { safeAddRole, safeRemoveRole, safeToggleRole } from "../../../core/roles.js";
import {
  parseSelfRoleButtonCustomId,
  parseSelfRoleSelectCustomId,
} from "../defaultOverrides.js";
import { getSelfRolePanel } from "./store.js";

function roleAllowed(panel: Awaited<ReturnType<typeof getSelfRolePanel>>, roleId: string): boolean {
  return panel?.config.roleIds.includes(roleId) ?? false;
}

export async function handleSelfRoleButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseSelfRoleButtonCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "Server only.", ephemeral: true });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "self_grantable_roles")) {
    await interaction.reply(
      resultReply("Disabled", "Self roles are disabled.", true, guildResultOptions(interaction.client, guildConfig, { tone: "unchecked" })),
    );
    return true;
  }

  const panel = await getSelfRolePanel(interaction.guildId, parsed.messageId);
  if (!panel || !roleAllowed(panel, parsed.roleId)) {
    await interaction.reply(
      resultReply("Unknown button", "This self-role button is no longer configured.", true, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
    );
    return true;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await interaction.reply(
      resultReply("Member error", "Could not resolve member.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const result = await safeToggleRole(member as import("discord.js").GuildMember, parsed.roleId, "Self role button");
  if (!result.ok) {
    await interaction.reply(
      resultReply("Could not update role", result.reason, true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const role = interaction.guild!.roles.cache.get(parsed.roleId);
  const action = result.added ? "Added" : "Removed";
  await interaction.reply(
    resultReply("Role updated", `${action} ${role ?? "role"}.`, true, guildResultOptions(interaction.client, guildConfig)),
  );
  return true;
}

export async function handleSelfRoleSelectInteraction(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const parsed = parseSelfRoleSelectCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "Server only.", ephemeral: true });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "self_grantable_roles")) {
    await interaction.reply(
      resultReply("Disabled", "Self roles are disabled.", true, guildResultOptions(interaction.client, guildConfig, { tone: "unchecked" })),
    );
    return true;
  }

  const panel = await getSelfRolePanel(interaction.guildId, parsed.messageId);
  if (!panel) {
    await interaction.reply(
      resultReply("Unknown panel", "This self-role panel is no longer configured.", true, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
    );
    return true;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await interaction.reply(
      resultReply("Member error", "Could not resolve member.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const guildMember = member as import("discord.js").GuildMember;
  const selected = new Set(interaction.values.filter((id) => roleAllowed(panel, id)));
  const allowedIds = panel.config.roleIds;

  const added: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];

  for (const roleId of allowedIds) {
    const has = guildMember.roles.cache.has(roleId);
    const shouldHave = selected.has(roleId);

    if (shouldHave && !has) {
      const result = await safeAddRole(guildMember, roleId, "Self role select");
      if (result.ok) {
        added.push(roleId);
      } else {
        errors.push(result.reason);
      }
    } else if (!shouldHave && has) {
      const result = await safeRemoveRole(guildMember, roleId, "Self role select");
      if (result.ok) {
        removed.push(roleId);
      } else {
        errors.push(result.reason);
      }
    }
  }

  const formatRoles = (ids: string[]) =>
    ids.map((id) => interaction.guild!.roles.cache.get(id)?.toString() ?? id).join(", ") || "none";

  let details = "";
  if (added.length > 0) details += `Added: ${formatRoles(added)}\n`;
  if (removed.length > 0) details += `Removed: ${formatRoles(removed)}\n`;
  if (added.length === 0 && removed.length === 0) details = "No role changes.";
  if (errors.length > 0) details += `\nErrors: ${errors.join("; ")}`;

  await interaction.reply(
    resultReply("Roles updated", details.trim(), true, guildResultOptions(interaction.client, guildConfig)),
  );
  return true;
}
