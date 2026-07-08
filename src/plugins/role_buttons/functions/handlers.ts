import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import { safeToggleRole } from "../../../core/roles.js";
import { parseRoleButtonCustomId, roleButtonCustomId } from "../defaultOverrides.js";
import { getRoleButtonPanel, listRoleButtonsForMessage } from "./store.js";

function parseButtonStyle(style: string) {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Secondary;
  }
}

export function buildRoleButtonRows(messageId: string, panels: Awaited<ReturnType<typeof listRoleButtonsForMessage>>) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();

  for (const panel of panels) {
    if (current.components.length >= 5) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
    }

    current.addComponents(
      new ButtonBuilder()
        .setCustomId(roleButtonCustomId(messageId, panel.roleId))
        .setLabel(panel.label)
        .setStyle(parseButtonStyle(panel.style)),
    );
  }

  if (current.components.length > 0) {
    rows.push(current);
  }

  return rows;
}

export async function handleRoleButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseRoleButtonCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "Server only.", ephemeral: true });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "role_buttons")) {
    await interaction.reply(
      resultReply("Disabled", "Role buttons are disabled.", true, guildResultOptions(interaction.client, guildConfig, { tone: "unchecked" })),
    );
    return true;
  }

  const panel = await getRoleButtonPanel(interaction.guildId, parsed.messageId, parsed.roleId);
  if (!panel) {
    await interaction.reply(
      resultReply("Unknown button", "This role button is no longer configured.", true, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
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

  const result = await safeToggleRole(member as import("discord.js").GuildMember, panel.roleId, "Role button");
  if (!result.ok) {
    await interaction.reply(
      resultReply("Could not update role", result.reason, true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const role = interaction.guild!.roles.cache.get(panel.roleId);
  const action = result.added ? "Added" : "Removed";
  await interaction.reply(
    resultReply(
      "Role updated",
      `${action} ${role ?? "role"}.`,
      true,
      guildResultOptions(interaction.client, guildConfig),
    ),
  );
  return true;
}
