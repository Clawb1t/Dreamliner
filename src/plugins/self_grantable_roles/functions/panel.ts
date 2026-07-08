import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Guild,
} from "discord.js";
import type { SelfRolePanelConfig } from "../defaultOverrides.js";
import { selfRoleButtonCustomId, selfRoleSelectCustomId } from "../defaultOverrides.js";

export function buildSelfRoleComponents(guild: Guild, messageId: string, config: SelfRolePanelConfig) {
  if (config.style === "select") {
    const options = config.roleIds
      .map((roleId) => {
        const role = guild.roles.cache.get(roleId);
        if (!role) return null;
        return { label: role.name.slice(0, 100), value: roleId };
      })
      .filter((o): o is { label: string; value: string } => o !== null);

    if (options.length === 0) return [];

    return [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(selfRoleSelectCustomId(messageId))
          .setPlaceholder("Choose your roles")
          .setMinValues(0)
          .setMaxValues(Math.min(options.length, 25))
          .addOptions(options),
      ),
    ];
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();

  for (const roleId of config.roleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    if (current.components.length >= 5) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
    }

    current.addComponents(
      new ButtonBuilder()
        .setCustomId(selfRoleButtonCustomId(messageId, roleId))
        .setLabel(role.name.slice(0, 80))
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (current.components.length > 0) {
    rows.push(current);
  }

  return rows;
}
