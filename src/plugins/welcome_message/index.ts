import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zWelcomeMessageConfig } from "../../config/schemas/plugins.js";
import { welcomeMessageDefaultOverrides } from "./defaultOverrides.js";
import { welcomeMessageCommands } from "./commands.js";
import { handleWelcomeMemberAdd } from "./functions/handlers.js";

export const welcomeMessagePlugin = definePlugin({
  name: "welcome_message",
  configSchema: zWelcomeMessageConfig,
  defaultOverrides: welcomeMessageDefaultOverrides,
  slashCommands: welcomeMessageCommands,
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleWelcomeMemberAdd(member as import("discord.js").GuildMember);
      },
    },
  ],
});
