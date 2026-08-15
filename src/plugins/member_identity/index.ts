import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zMemberIdentityConfig } from "../../config/schemas/plugins.js";
import { configManager } from "../../config/manager.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { getMemberIdentityConfig, identityChanged, restoreMemberIdentity, saveMemberIdentity } from "./functions/handlers.js";

export const memberIdentityPlugin = definePlugin({
  name: "member_identity",
  configSchema: zMemberIdentityConfig,
  slashCommands: [],
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember;
        if (!m.guild) return;
        await restoreMemberIdentity(m).catch(() => null);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember | import("discord.js").PartialGuildMember;
        if (!m.guild) return;

        const guildConfig = await configManager.getEffectiveConfig(m.guild.id);
        if (!pluginEnabled(guildConfig, "member_identity")) return;
        if (!getMemberIdentityConfig(guildConfig).save_on_leave) return;

        await saveMemberIdentity(m, { mergeIfSparse: true }).catch(() => null);
      },
    },
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        const oldM = oldMember as import("discord.js").GuildMember | import("discord.js").PartialGuildMember;
        const newM = newMember as import("discord.js").GuildMember;
        if (!newM.guild) return;
        if (!identityChanged(oldM, newM)) return;

        const guildConfig = await configManager.getEffectiveConfig(newM.guild.id);
        if (!pluginEnabled(guildConfig, "member_identity")) return;
        if (!getMemberIdentityConfig(guildConfig).save_on_update) return;

        await saveMemberIdentity(newM).catch(() => null);
      },
    },
  ],
});
