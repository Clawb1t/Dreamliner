import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zImpersonationConfig } from "../../config/schemas/impersonation.js";
import { impersonationCommands } from "./commands.js";
import {
  handleImpersonationMemberAdd,
  handleImpersonationMemberUpdate,
  handleImpersonationUserUpdate,
} from "./functions/handlers.js";

export const impersonationPlugin = definePlugin({
  name: "impersonation",
  configSchema: zImpersonationConfig,
  slashCommands: impersonationCommands,
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleImpersonationMemberAdd(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        await handleImpersonationMemberUpdate(
          oldMember as import("discord.js").GuildMember,
          newMember as import("discord.js").GuildMember,
        );
      },
    },
    {
      name: Events.UserUpdate,
      execute: async (_client, oldUser: unknown, newUser: unknown) => {
        await handleImpersonationUserUpdate(
          oldUser as import("discord.js").User,
          newUser as import("discord.js").User,
        );
      },
    },
  ],
});
