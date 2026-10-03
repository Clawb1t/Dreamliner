import { Events, type GuildMember, type PartialGuildMember } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zRolesConfig } from "../../config/schemas/plugins.js";
import { configManager } from "../../config/manager.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { rolesCommands } from "./commands/manage.js";
import { loadRolesConfig } from "./functions/config.js";
import { applyRoleRules } from "./functions/rules.js";

/** Runs the server's if-then role rules for a member, when the plugin is on and has any. */
async function runRules(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!pluginEnabled(guildConfig, "roles")) return;
  const rules = loadRolesConfig(guildConfig).rules.filter((rule) => rule.enabled);
  if (rules.length > 0) await applyRoleRules(member, rules);
}

function sameRoles(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): boolean {
  // A partial (uncached) old member has no role list to compare, so treat it as changed.
  if (oldMember.partial) return false;
  const before = oldMember.roles.cache;
  const after = newMember.roles.cache;
  return before.size === after.size && after.every((_, id) => before.has(id));
}

export const rolesPlugin = definePlugin({
  name: "roles",
  configSchema: zRolesConfig,
  slashCommands: rolesCommands,
  events: [
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        const after = newMember as GuildMember;
        if (!after.guild || sameRoles(oldMember as GuildMember | PartialGuildMember, after)) return;
        await runRules(after);
      },
    },
    {
      // Roles a member already has when they join (e.g. restored ones) count too.
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        const joined = member as GuildMember;
        if (joined.guild && joined.roles.cache.size > 1) await runRules(joined);
      },
    },
  ],
});
