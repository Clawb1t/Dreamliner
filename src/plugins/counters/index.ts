import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCountersConfig } from "../../config/schemas/plugins.js";
import { countersDefaultOverrides } from "./defaultOverrides.js";
import { countersCommands } from "./commands.js";
import { handleCounterMemberChange, handleCounterMessage } from "./functions/handlers.js";

export const countersPlugin = definePlugin({
  name: "counters",
  configSchema: zCountersConfig,
  defaultOverrides: countersDefaultOverrides,
  slashCommands: countersCommands,
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleCounterMemberChange(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        await handleCounterMemberChange(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleCounterMessage(message as import("discord.js").Message);
      },
    },
  ],
});
