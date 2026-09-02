import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { findPermissionCatalogEntry, getPermissionCatalog, grantKeyFor } from "../../../core/permissionCatalog.js";
import { permissionRoleManager, type PermissionRoleDetail } from "../../../config/permissionRoleManager.js";
import { autocompletePermissionTargets, findPermissionTarget, type PermissionTarget } from "../permissionTargets.js";

// Discord-side surface for Dreamliner Roles — a lighter-weight secondary surface to the
// dashboard's Roles page (the grouped permission-toggle grid), useful for admins who'd rather
// script/CLI their way through role setup than click through a web UI. See docs/permissions.md.

function roleLabel(role: { name: string; builtIn: string | null }): string {
  return role.builtIn ? `${role.name} (built-in)` : role.name;
}

async function resolveRoleOption(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<PermissionRoleDetail | { error: string }> {
  const raw = interaction.options.getString("role", true);
  const roleId = Number(raw);
  if (!Number.isInteger(roleId)) return { error: "Pick a role from the autocomplete list." };
  const role = await permissionRoleManager.getRole(guildId, roleId);
  if (!role) return { error: "That Dreamliner Role no longer exists." };
  return role;
}

function resolveCommandTarget(interaction: ChatInputCommandInteraction): PermissionTarget | null {
  const raw = interaction.options.getString("command", true);
  return findPermissionTarget(raw) ?? null;
}

function resolveDiscordTarget(
  interaction: ChatInputCommandInteraction,
): { ok: true; type: "role" | "user"; id: string; label: string } | { ok: false; error: string } {
  const discordRole = interaction.options.getRole("discord_role");
  const discordUser = interaction.options.getUser("discord_user");
  const selected = [Boolean(discordRole), Boolean(discordUser)].filter(Boolean).length;
  if (selected !== 1) return { ok: false, error: "Choose exactly one of `discord_role` or `discord_user`." };
  if (discordRole) {
    if (interaction.guild && discordRole.id === interaction.guild.id) {
      return { ok: false, error: "The @everyone role can't be assigned — every member already belongs to the Member role." };
    }
    return { ok: true, type: "role", id: discordRole.id, label: `<@&${discordRole.id}>` };
  }
  return { ok: true, type: "user", id: discordUser!.id, label: `<@${discordUser!.id}>` };
}

export async function handlePermissionsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);

  if (focused.name === "command") {
    const matches = autocompletePermissionTargets(focused.value);
    await interaction.respond(matches.map((target) => ({ name: target.label, value: target.key })));
    return;
  }

  if (focused.name === "role") {
    if (!interaction.guildId) {
      await interaction.respond([]);
      return;
    }
    const roles = await permissionRoleManager.listRoles(interaction.guildId);
    const query = String(focused.value ?? "").trim().toLowerCase();
    const matches = roles.filter((r) => !query || r.name.toLowerCase().includes(query)).slice(0, 25);
    await interaction.respond(matches.map((r) => ({ name: roleLabel(r), value: String(r.id) })));
    return;
  }

  await interaction.respond([]);
}

export const permissionsCommand: SlashCommandDefinition = {
  plugin: "config",
  manageServer: true,
  data: new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Manage Dreamliner Roles — who can use which commands")
    .addSubcommandGroup((group) =>
      group
        .setName("role")
        .setDescription("Create, assign, and grant permissions to Dreamliner Roles")
        .addSubcommand((sub) =>
          sub
            .setName("create")
            .setDescription("Create a new Dreamliner Role")
            .addStringOption((o) => o.setName("name").setDescription("Role name").setRequired(true).setMaxLength(100)),
        )
        .addSubcommand((sub) =>
          sub
            .setName("delete")
            .setDescription("Delete a custom Dreamliner Role")
            .addStringOption((o) => o.setName("role").setDescription("Role to delete").setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((sub) =>
          sub
            .setName("rename")
            .setDescription("Rename a Dreamliner Role")
            .addStringOption((o) => o.setName("role").setDescription("Role to rename").setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName("new_name").setDescription("New name").setRequired(true).setMaxLength(100)),
        )
        .addSubcommand((sub) =>
          sub
            .setName("assign")
            .setDescription("Assign a Discord role or member into a Dreamliner Role")
            .addStringOption((o) => o.setName("role").setDescription("Dreamliner Role").setRequired(true).setAutocomplete(true))
            .addRoleOption((o) => o.setName("discord_role").setDescription("Discord role to assign"))
            .addUserOption((o) => o.setName("discord_user").setDescription("Member to assign")),
        )
        .addSubcommand((sub) =>
          sub
            .setName("unassign")
            .setDescription("Remove a Discord role or member from a Dreamliner Role")
            .addStringOption((o) => o.setName("role").setDescription("Dreamliner Role").setRequired(true).setAutocomplete(true))
            .addRoleOption((o) => o.setName("discord_role").setDescription("Discord role to remove"))
            .addUserOption((o) => o.setName("discord_user").setDescription("Member to remove")),
        )
        .addSubcommand((sub) =>
          sub
            .setName("grant")
            .setDescription("Grant or revoke a command's permission on a Dreamliner Role")
            .addStringOption((o) => o.setName("role").setDescription("Dreamliner Role").setRequired(true).setAutocomplete(true))
            .addStringOption((o) =>
              o.setName("command").setDescription("Command to grant/revoke").setRequired(true).setAutocomplete(true),
            )
            .addBooleanOption((o) => o.setName("allow").setDescription("Grant (true) or revoke (false)").setRequired(true)),
        )
        .addSubcommand((sub) => sub.setName("list").setDescription("List this server's Dreamliner Roles"))
        .addSubcommand((sub) =>
          sub
            .setName("view")
            .setDescription("View a Dreamliner Role's assigned targets and granted permissions")
            .addStringOption((o) => o.setName("role").setDescription("Dreamliner Role").setRequired(true).setAutocomplete(true)),
        ),
    ),
  execute: async (ctx) => {
    const { interaction, ephemeral } = ctx;
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;
    const opts = slashResultOptions(ctx);

    if (sub === "create") {
      const name = interaction.options.getString("name", true).trim();
      if (!name) {
        await interaction.reply(resultReply("Invalid name", "Give the role a name.", ephemeral, { ...opts, tone: "error" }));
        return;
      }
      const role = await permissionRoleManager.createRole(guildId, name, interaction.user.id);
      await interaction.reply(
        resultReply("Role created", `Created **${role.name}**. Assign Discord roles/members and grant permissions next.`, ephemeral, {
          ...opts,
          tone: "success",
          emoji: "<:icons_roles:1544417804994871338>",
        }),
      );
      return;
    }

    if (sub === "list") {
      const roles = await permissionRoleManager.listRoles(guildId);
      const lines = roles.map(
        (r) => `• **${roleLabel(r)}** — ${r.targetCount} target${r.targetCount === 1 ? "" : "s"}, ${r.grantCount} permission${r.grantCount === 1 ? "" : "s"}`,
      );
      await interaction.reply(
        resultReply("Dreamliner Roles", lines.join("\n") || "No roles yet.", ephemeral, {
          ...opts,
          emoji: "<:icons_roles:1544417804994871338>",
        }),
      );
      return;
    }

    // Every remaining subcommand takes a `role` option.
    const role = await resolveRoleOption(interaction, guildId);
    if ("error" in role) {
      await interaction.reply(resultReply("Not found", role.error, ephemeral, { ...opts, tone: "error" }));
      return;
    }

    if (sub === "view") {
      const targetLines = role.targets.map((t) => (t.type === "role" ? `• Role <@&${t.id}>` : `• Member <@${t.id}>`));
      const grantLines = role.grants
        .map((key) => findPermissionCatalogEntry(key)?.title ?? key)
        .sort((a, b) => a.localeCompare(b))
        .map((title) => `• ${title}`);
      const body = [
        `**${roleLabel(role)}**`,
        "",
        role.builtIn === "member"
          ? "**Applies to:** everyone (implicit — no targets to assign)"
          : `**Assigned targets**\n${targetLines.join("\n") || "• None yet — this role grants nothing until you assign a Discord role or member."}`,
        "",
        `**Granted permissions**\n${grantLines.join("\n") || "• None yet."}`,
      ].join("\n");
      await interaction.reply(resultReply("Role details", body, ephemeral, { ...opts, emoji: "<:icons_id:1544417556868104274>" }));
      return;
    }

    if (sub === "delete") {
      const result = await permissionRoleManager.deleteRole(guildId, role.id, interaction.user.id);
      if (!result.success) {
        await interaction.reply(resultReply("Could not delete role", result.error, ephemeral, { ...opts, tone: "error" }));
        return;
      }
      await interaction.reply(
        resultReply("Role deleted", `Deleted **${role.name}**.`, ephemeral, { ...opts, tone: "success", emoji: "<:icons_locked:1544417721612247171>" }),
      );
      return;
    }

    if (sub === "rename") {
      const newName = interaction.options.getString("new_name", true).trim();
      if (!newName) {
        await interaction.reply(resultReply("Invalid name", "Give the role a name.", ephemeral, { ...opts, tone: "error" }));
        return;
      }
      const result = await permissionRoleManager.renameRole(guildId, role.id, newName, interaction.user.id);
      if (!result.success) {
        await interaction.reply(resultReply("Could not rename role", result.error, ephemeral, { ...opts, tone: "error" }));
        return;
      }
      await interaction.reply(
        resultReply("Role renamed", `**${role.name}** is now **${result.data.name}**.`, ephemeral, { ...opts, tone: "success" }),
      );
      return;
    }

    if (sub === "assign" || sub === "unassign") {
      if (role.builtIn === "member") {
        await interaction.reply(
          resultReply("Can't assign targets", "The Member role applies to everyone automatically — it has nothing to assign.", ephemeral, { ...opts, tone: "error" }),
        );
        return;
      }
      const discordTarget = resolveDiscordTarget(interaction);
      if (!discordTarget.ok) {
        await interaction.reply(resultReply("Invalid target", discordTarget.error, ephemeral, { ...opts, tone: "error" }));
        return;
      }

      const nextTargets =
        sub === "assign"
          ? [...role.targets, { type: discordTarget.type, id: discordTarget.id }]
          : role.targets.filter((t) => !(t.type === discordTarget.type && t.id === discordTarget.id));

      const result = await permissionRoleManager.setTargets(guildId, role.id, nextTargets, interaction.user.id);
      if (!result.success) {
        await interaction.reply(resultReply("Could not update role", result.error, ephemeral, { ...opts, tone: "error" }));
        return;
      }
      await interaction.reply(
        resultReply(
          sub === "assign" ? "Assigned" : "Unassigned",
          `${discordTarget.label} ${sub === "assign" ? "assigned to" : "removed from"} **${role.name}**.`,
          ephemeral,
          { ...opts, tone: "success", emoji: sub === "assign" ? "<:icons_unlock:1544417749617610852>" : "<:icons_locked:1544417721612247171>" },
        ),
      );
      return;
    }

    if (sub === "grant") {
      const target = resolveCommandTarget(interaction);
      if (!target) {
        await interaction.reply(resultReply("Unknown command", "Pick a command from the autocomplete list.", ephemeral, { ...opts, tone: "error" }));
        return;
      }
      const allow = interaction.options.getBoolean("allow", true);
      const grantKey = grantKeyFor(target.plugin, target.permission);
      const result = await permissionRoleManager.setGrant(guildId, role.id, grantKey, allow, interaction.user.id);
      if (!result.success) {
        await interaction.reply(resultReply("Could not update role", result.error, ephemeral, { ...opts, tone: "error" }));
        return;
      }
      await interaction.reply(
        resultReply(
          allow ? "Permission granted" : "Permission revoked",
          `${allow ? "Granted" : "Revoked"} **${target.label}** on **${role.name}**.`,
          ephemeral,
          { ...opts, tone: "success", emoji: allow ? "<:icons_unlock:1544417749617610852>" : "<:icons_locked:1544417721612247171>" },
        ),
      );
    }
  },
};

// getPermissionCatalog is re-exported for anything (e.g. tests) that wants the full catalog without going through the bridge.
export { getPermissionCatalog };
