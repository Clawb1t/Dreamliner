import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zPassportConfig } from "../../config/schemas/passport.js";
import { passportDefaultOverrides } from "./defaultOverrides.js";
import { passportCommands } from "./commands.js";
import { handlePassportMemberAdd, handlePassportMemberRemove } from "./functions/handlers.js";
import { processExpiredPassports } from "./functions/timeout.js";

export const passportPlugin = definePlugin({
  name: "passport",
  configSchema: zPassportConfig,
  defaultOverrides: passportDefaultOverrides,
  slashCommands: passportCommands,
  onLoad: async ({ client }) => {
    setInterval(() => {
      processExpiredPassports(client).catch((err) => {
        console.error("Passport timeout sweep failed:", err);
      });
    }, 60_000);
  },
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handlePassportMemberAdd(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        await handlePassportMemberRemove(
          member as import("discord.js").GuildMember | import("discord.js").PartialGuildMember,
        );
      },
    },
  ],
});
