import type { ButtonInteraction, Client, MessageReaction, User } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { RolePanel } from "../../../config/schemas/rolePanels.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { emojiKeysMatch } from "../../../core/emoji.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import { safeAddRole, safeRemoveRole, safeToggleRole } from "../../../core/roles.js";
import { parseRolePanelButtonCustomId } from "../customIds.js";
import { findRolePanelMessageByDiscordMessage } from "./store.js";
import { getLogger } from "../../../core/logger.js";
import { translatorFor } from "../../../i18n/index.js";
const log = getLogger("role_panels");

function loadPanels(guildConfig: Awaited<ReturnType<typeof configManager.getEffectiveConfig>>): RolePanel[] {
  const section = guildConfig.plugins.role_panels as { config?: { panels?: RolePanel[] } } | undefined;
  return section?.config?.panels ?? [];
}

/** Removes every other role in the panel the member currently holds — used by selection_mode:"single". */
async function enforceSingleSelection(
  member: import("discord.js").GuildMember,
  panel: RolePanel,
  pickedRoleId: string,
): Promise<void> {
  for (const role of panel.roles) {
    if (role.role_id === pickedRoleId) continue;
    if (member.roles.cache.has(role.role_id)) {
      await safeRemoveRole(member, role.role_id, "Role panel (single choice)");
    }
  }
}

export async function handleRolePanelReaction(
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

  const tracked = await findRolePanelMessageByDiscordMessage(message.guild.id, message.id);
  if (!tracked) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "role_panels")) return;

  const panel = loadPanels(guildConfig).find((p) => p.id === tracked.panelId);
  if (!panel || !panel.enabled || panel.trigger_type !== "reaction") return;

  const matched = panel.roles.find((r) => emojiKeysMatch(r.emoji, reaction.emoji));
  if (!matched) return;

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  if (action === "add") {
    await safeAddRole(member, matched.role_id, "Role panel");
    if (panel.selection_mode === "single") {
      await enforceSingleSelection(member, panel, matched.role_id);
      for (const role of panel.roles) {
        if (role.role_id === matched.role_id) continue;
        const otherReaction = [...message.reactions.cache.values()].find((r) => r.me && emojiKeysMatch(role.emoji, r.emoji));
        if (otherReaction) {
          await otherReaction.users.remove(user.id).catch((error) => {
            log.warn(
              `[role_panels] Could not remove ${user.id}'s other reaction for single-choice panel ${panel.id} (likely missing Manage Messages):`,
              error instanceof Error ? error.message : error,
            );
          });
        }
      }
    }
    return;
  }

  if (panel.remove_on_unreact) {
    await safeRemoveRole(member, matched.role_id, "Role panel (unreacted)");
  }
}

export async function handleRolePanelButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseRolePanelButtonCustomId(interaction.customId);
  if (!parsed) return false;

  const { t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: t("role_panels.serverOnly", "Server only."), ephemeral: true });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "role_panels")) {
    await interaction.reply(
      resultReply(
        t("role_panels.disabledTitle", "Disabled"),
        t("role_panels.disabledDesc", "Role panels are disabled."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "unchecked" }),
      ),
    );
    return true;
  }

  const panel = loadPanels(guildConfig).find((p) => p.id === parsed.panelId);
  if (!panel || !panel.enabled || panel.trigger_type !== "button") {
    await interaction.reply(
      resultReply(
        t("role_panels.unknownButtonTitle", "Unknown button"),
        t("role_panels.unknownButtonDesc", "This role panel is no longer configured."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
      ),
    );
    return true;
  }

  const roleEntry = panel.roles.find((r) => r.role_id === parsed.roleId);
  if (!roleEntry) {
    await interaction.reply(
      resultReply(
        t("role_panels.unknownRoleTitle", "Unknown role"),
        t("role_panels.unknownRoleDesc", "This role is no longer part of the panel."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
      ),
    );
    return true;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await interaction.reply(
      resultReply(
        t("role_panels.memberErrorTitle", "Member error"),
        t("role_panels.memberErrorDesc", "Could not resolve member."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const guildMember = member as import("discord.js").GuildMember;

  if (panel.selection_mode === "single") {
    const already = guildMember.roles.cache.has(roleEntry.role_id);
    const result = already
      ? await safeRemoveRole(guildMember, roleEntry.role_id, "Role panel")
      : await safeAddRole(guildMember, roleEntry.role_id, "Role panel");
    if (!result.ok) {
      await interaction.reply(
        resultReply(
          t("role_panels.couldNotUpdateTitle", "Could not update role"),
          result.reason,
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return true;
    }
    if (!already) await enforceSingleSelection(guildMember, panel, roleEntry.role_id);
    const role = interaction.guild!.roles.cache.get(roleEntry.role_id);
    await interaction.reply(
      resultReply(
        t("role_panels.roleUpdatedTitle", "Role updated"),
        t("role_panels.roleUpdatedDesc", "{action} {role}.", {
          action: already
            ? t("role_panels.actionRemoved", "Removed")
            : t("role_panels.actionAdded", "Added"),
          role: role ? role.toString() : t("role_panels.roleFallback", "role"),
        }),
        true,
        guildResultOptions(interaction.client, guildConfig, {
          emoji: already ? "<:icons_off:1544417567777628201>" : "<:icons_on:1544417570818629753>",
        }),
      ),
    );
    return true;
  }

  const result = await safeToggleRole(guildMember, roleEntry.role_id, "Role panel");
  if (!result.ok) {
    await interaction.reply(
      resultReply(
        t("role_panels.couldNotUpdateTitle", "Could not update role"),
        result.reason,
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const role = interaction.guild!.roles.cache.get(roleEntry.role_id);
  await interaction.reply(
    resultReply(
      t("role_panels.roleUpdatedTitle", "Role updated"),
      t("role_panels.roleUpdatedDesc", "{action} {role}.", {
        action: result.added
          ? t("role_panels.actionAdded", "Added")
          : t("role_panels.actionRemoved", "Removed"),
        role: role ? role.toString() : t("role_panels.roleFallback", "role"),
      }),
      true,
      guildResultOptions(interaction.client, guildConfig, {
        emoji: result.added ? "<:icons_on:1544417570818629753>" : "<:icons_off:1544417567777628201>",
      }),
    ),
  );
  return true;
}
