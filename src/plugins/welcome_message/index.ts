import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zWelcomeMessageConfig } from "../../config/schemas/welcome.js";
import { welcomeMessageCommands } from "./commands.js";
import { handleWelcomeMemberAdd, handleWelcomeMemberRemove } from "./functions/handlers.js";
import { handleWelcomeFirstMessage } from "./functions/firstMessageReact.js";

export const welcomeMessagePlugin = definePlugin({
  name: "welcome_message",
  configSchema: zWelcomeMessageConfig,
  slashCommands: welcomeMessageCommands,
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleWelcomeMemberAdd(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        await handleWelcomeMemberRemove(
          member as import("discord.js").GuildMember | import("discord.js").PartialGuildMember,
        );
      },
    },
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleWelcomeFirstMessage(message as import("discord.js").Message);
      },
    },
  ],
});
