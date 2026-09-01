import {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommandDefinition, ConfigOverride } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import {
  autocompletePermissionTargets,
  findPermissionTarget,
  type PermissionTarget,
} from "../permissionTargets.js";

function withTargetOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub
    .addStringOption((o) =>
      o.setName("command").setDescription("Command to change access for").setRequired(true).setAutocomplete(true),
    )
    .addUserOption((o) => o.setName("user").setDescription("Grant or revoke for this user"))
    .addRoleOption((o) => o.setName("role").setDescription("Grant or revoke for this role"))
    .addBooleanOption((o) => o.setName("everyone").setDescription("Grant or revoke for everyone in the server"));
}

function resolveGrantTarget(interaction: ChatInputCommandInteraction):
  | { ok: true; everyone?: boolean; user?: string; role?: string; label: string }
  | { ok: false; error: string } {
  const user = interaction.options.getUser("user");
  const role = interaction.options.getRole("role");
  const everyone = interaction.options.getBoolean("everyone") === true;

  const selected = [everyone, Boolean(user), Boolean(role)].filter(Boolean).length;
  if (selected === 0) {
    return { ok: false, error: "Choose one of: `user`, `role`, or `everyone`." };
  }
  if (selected > 1) {
    return { ok: false, error: "Choose only one of: `user`, `role`, or `everyone`." };
  }
  if (everyone) return { ok: true, everyone: true, label: "everyone" };
  if (user) return { ok: true, user: user.id, label: `<@${user.id}>` };
  if (role) {
    if (interaction.guild && role.id === interaction.guild.id) {
      return { ok: false, error: "Use `everyone: True` instead of the @everyone role." };
    }
    return { ok: true, role: role.id, label: `<@&${role.id}>` };
  }
  return { ok: false, error: "Choose one of: `user`, `role`, or `everyone`." };
}

function resolveCommandTarget(interaction: ChatInputCommandInteraction): PermissionTarget | null {
  const raw = interaction.options.getString("command", true);
  return findPermissionTarget(raw) ?? null;
}

function describeDefaultAccess(target: PermissionTarget): string {
  const defaults = getPluginDefaultOverrides(target.plugin);
  const levels: string[] = [];
  for (const override of defaults) {
    if (override.level && override.config[target.permission] === true) {
      levels.push(override.level);
    }
  }
  if (levels.length === 0) return "No default level grant.";
  return `Default: granted at level ${levels.join(" or ")}.`;
}

function collectCustomGrants(guildConfig: GuildConfig, target: PermissionTarget): string[] {
  const section = guildConfig.plugins[target.plugin as keyof typeof guildConfig.plugins] as
    | { config?: Record<string, unknown>; overrides?: ConfigOverride[] }
    | undefined;
  const lines: string[] = [];

  if (section?.config?.[target.permission] === true) {
    lines.push("• Everyone (base config)");
  }

  for (const override of section?.overrides ?? []) {
    if (override.config[target.permission] !== true) continue;
    // Level-only overrides usually come from defaults; /permissions allow writes user/role grants.
    if (override.user) lines.push(`• User <@${override.user}>`);
    else if (override.role) lines.push(`• Role <@&${override.role}>`);
    else if (override.level && (override.channel || override.category)) {
      const extras = [
        override.channel ? `channel <#${override.channel}>` : null,
        override.category ? `category ${override.category}` : null,
      ].filter(Boolean);
      lines.push(`• Level ${override.level} (${extras.join(", ")})`);
    }
  }

  return lines;
}

export async function handlePermissionsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "command") {
    await interaction.respond([]);
    return;
  }

  const matches = autocompletePermissionTargets(focused.value);
  await interaction.respond(matches.map((target) => ({ name: target.label, value: target.key })));
}

export const permissionsCommand: SlashCommandDefinition = {
  plugin: "config",
  manageServer: true,
  data: new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Manage who can use Dreamliner commands")
    .addSubcommand((sub) => withTargetOptions(sub.setName("allow").setDescription("Allow a user, role, or everyone to use a command")))
    .addSubcommand((sub) => withTargetOptions(sub.setName("deny").setDescription("Remove a user, role, or everyone grant for a command")))
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Show who can use a command")
        .addStringOption((o) =>
          o.setName("command").setDescription("Command to inspect").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("level")
        .setDescription("Manage permission levels for roles and users")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set a role or user's permission level (50 = mod, 100 = admin by default)")
            .addIntegerOption((o) =>
              o.setName("level").setDescription("Permission level").setRequired(true).setMinValue(0).setMaxValue(9999),
            )
            .addUserOption((o) => o.setName("user").setDescription("User to assign a level"))
            .addRoleOption((o) => o.setName("role").setDescription("Role to assign a level")),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Remove a role or user's permission level")
            .addUserOption((o) => o.setName("user").setDescription("User to clear"))
            .addRoleOption((o) => o.setName("role").setDescription("Role to clear")),
        )
        .addSubcommand((sub) => sub.setName("list").setDescription("List configured permission levels")),
    ),
  execute: async (ctx) => {
    const { interaction, guildConfig, configManager, ephemeral } = ctx;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;
    const opts = slashResultOptions(ctx);

    if (group === "level") {
      if (sub === "list") {
        const entries = Object.entries(guildConfig.levels);
        if (entries.length === 0) {
          await interaction.reply(
            resultReply(
              "Permission levels",
              "No levels configured yet. Use `/permissions level set` to assign a role or user a level.",
              ephemeral,
              opts,
            ),
          );
          return;
        }

        const sorted = entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const lines = sorted.map(([id, level]) => {
          const mention = interaction.guild?.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`;
          return `• ${mention} — **${level}**`;
        });
        await interaction.reply(
          resultReply("Permission levels", lines.join("\n"), ephemeral, {
            ...opts,
            emoji: "<:icons_roles:1544417804994871338>",
          }),
        );
        return;
      }

      const user = interaction.options.getUser("user");
      const role = interaction.options.getRole("role");
      const selected = [Boolean(user), Boolean(role)].filter(Boolean).length;
      if (selected !== 1) {
        await interaction.reply(
          resultReply("Invalid target", "Choose exactly one of `user` or `role`.", ephemeral, { ...opts, tone: "error" }),
        );
        return;
      }

      const targetId = user?.id ?? role!.id;
      const label = user ? `<@${user.id}>` : `<@&${role!.id}>`;

      if (sub === "set") {
        const level = interaction.options.getInteger("level", true);
        const result = await configManager.patchLevels(guildId, { [targetId]: level }, interaction.user.id);
        if (!result.success) {
          await interaction.reply(resultReply("Could not update level", result.errors.join("\n"), ephemeral, { ...opts, tone: "error" }));
          return;
        }
        await interaction.reply(
          resultReply("Level updated", `Set ${label} to level **${level}**.`, ephemeral, {
            ...opts,
            tone: "success",
            emoji: "<:icons_up_arrow:1544418259363700856>",
          }),
        );
        return;
      }

      if (sub === "remove") {
        if (!(targetId in guildConfig.levels)) {
          await interaction.reply(
            resultReply("Not found", `${label} does not have a configured level.`, ephemeral, { ...opts, tone: "warning" }),
          );
          return;
        }
        const result = await configManager.patchLevels(guildId, { [targetId]: null }, interaction.user.id);
        if (!result.success) {
          await interaction.reply(resultReply("Could not update level", result.errors.join("\n"), ephemeral, { ...opts, tone: "error" }));
          return;
        }
        await interaction.reply(
          resultReply("Level removed", `Cleared the level for ${label}.`, ephemeral, {
            ...opts,
            tone: "success",
            emoji: "<:icons_downarrow:1544417541873471488>",
          }),
        );
        return;
      }
    }

    if (sub === "show") {
      const target = resolveCommandTarget(interaction);
      if (!target) {
        await interaction.reply(
          resultReply("Unknown command", "Pick a command from the autocomplete list.", ephemeral, { ...opts, tone: "error" }),
        );
        return;
      }

      const grants = collectCustomGrants(guildConfig, target);
      const body = [
        `**${target.label}** (\`${target.permission}\` in \`${target.plugin}\`)`,
        describeDefaultAccess(target),
        "",
        grants.length > 0 ? `**Configured grants**\n${grants.join("\n")}` : "**Configured grants**\n• None beyond defaults",
      ].join("\n");

      await interaction.reply(
        resultReply("Command permissions", body, ephemeral, {
          ...opts,
          emoji: "<:icons_id:1544417556868104274>",
        }),
      );
      return;
    }

    if (sub === "allow" || sub === "deny") {
      const target = resolveCommandTarget(interaction);
      if (!target) {
        await interaction.reply(
          resultReply("Unknown command", "Pick a command from the autocomplete list.", ephemeral, { ...opts, tone: "error" }),
        );
        return;
      }

      const grantTarget = resolveGrantTarget(interaction);
      if (!grantTarget.ok) {
        await interaction.reply(resultReply("Invalid target", grantTarget.error, ephemeral, { ...opts, tone: "error" }));
        return;
      }

      const allowed = sub === "allow";
      const result = await configManager.setPermissionGrant(
        guildId,
        target.plugin,
        target.permission,
        { everyone: grantTarget.everyone, user: grantTarget.user, role: grantTarget.role },
        allowed,
        interaction.user.id,
      );

      if (!result.success) {
        await interaction.reply(
          resultReply("Could not update permissions", result.errors.join("\n"), ephemeral, { ...opts, tone: "error" }),
        );
        return;
      }

      const action = allowed ? "Allowed" : "Removed access for";
      const note = grantTarget.everyone && !allowed ? " Level and role/user grants still apply." : "";
      await interaction.reply(
        resultReply(
          allowed ? "Permission granted" : "Permission updated",
          `${action} ${grantTarget.label} on **${target.label}**.${note}`,
          ephemeral,
          {
            ...opts,
            tone: "success",
            emoji: allowed
              ? "<:icons_unlock:1544417749617610852>"
              : "<:icons_locked:1544417721612247171>",
          },
        ),
      );
    }
  },
};
