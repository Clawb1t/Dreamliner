import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zReactionRolesConfig } from "../../config/schemas/plugins.js";
import { handleReactionRole } from "./functions/handlers.js";

/**
 * Legacy — superseded by the `role_panels` plugin's dashboard editor. `/reactionrole` is removed
 * (slashCommands: [], see src/plugins/bot_customisation/ for the same zero-command precedent);
 * this plugin stays registered only so mappings created before the change keep working.
 */
export const reactionRolesPlugin = definePlugin({
  name: "reaction_roles",
  configSchema: zReactionRolesConfig,
  slashCommands: [],
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
