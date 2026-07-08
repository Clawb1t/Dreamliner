import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zReactionRolesConfig } from "../../config/schemas/plugins.js";
import { reactionRolesDefaultOverrides } from "./defaultOverrides.js";
import { reactionRoleCommands } from "./commands/manage.js";
import { handleReactionRole } from "./functions/handlers.js";

export const reactionRolesPlugin = definePlugin({
  name: "reaction_roles",
  configSchema: zReactionRolesConfig,
  defaultOverrides: reactionRolesDefaultOverrides,
  slashCommands: reactionRoleCommands,
  events: [
    {
      name: Events.MessageReactionAdd,
      execute: async (_client, reaction: unknown, user: unknown) => {
        await handleReactionRole(
          _client,
          reaction as import("discord.js").MessageReaction,
          user as import("discord.js").User,
          "add",
        );
      },
    },
    {
      name: Events.MessageReactionRemove,
      execute: async (_client, reaction: unknown, user: unknown) => {
        await handleReactionRole(
          _client,
          reaction as import("discord.js").MessageReaction,
          user as import("discord.js").User,
          "remove",
        );
      },
    },
  ],
});
