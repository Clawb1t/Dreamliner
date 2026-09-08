import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zPassportConfig } from "../../config/schemas/passport.js";
import { passportCommands } from "./commands.js";
import { handlePassportMemberAdd, handlePassportMemberRemove } from "./functions/handlers.js";
import { processExpiredPassports } from "./functions/timeout.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("passport");

export const passportPlugin = definePlugin({
  name: "passport",
  configSchema: zPassportConfig,
  slashCommands: passportCommands,
  onLoad: async ({ client }) => {
    setInterval(() => {
      processExpiredPassports(client).catch((err) => {
        log.error("Passport timeout sweep failed:", err);
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
