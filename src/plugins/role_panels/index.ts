import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zRolePanelsConfig } from "../../config/schemas/plugins.js";
import { rolePanelsDefaultOverrides } from "./defaultOverrides.js";
import { handleRolePanelReaction } from "./functions/handlers.js";
import { handleRolePanelsReady, syncGuildRolePanels } from "./functions/sync.js";

export const rolePanelsPlugin = definePlugin({
  name: "role_panels",
  configSchema: zRolePanelsConfig,
  defaultOverrides: rolePanelsDefaultOverrides,
  slashCommands: [],
  onLoad: async ({ client, configManager }) => {
    configManager.onSave((guildId, config) => {
      void syncGuildRolePanels(client, guildId, { guildConfig: config }).catch((error) => {
        console.error(`[role_panels] Failed to apply panel config for ${guildId}:`, error);
      });
    });
  },
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        await handleRolePanelsReady(client as import("discord.js").Client);
      },
    },
    {
      name: Events.MessageReactionAdd,
      execute: async (client, reaction: unknown, user: unknown) => {
        await handleRolePanelReaction(
          client,
          reaction as import("discord.js").MessageReaction,
          user as import("discord.js").User,
          "add",
        );
      },
    },
    {
      name: Events.MessageReactionRemove,
      execute: async (client, reaction: unknown, user: unknown) => {
        await handleRolePanelReaction(
          client,
          reaction as import("discord.js").MessageReaction,
          user as import("discord.js").User,
          "remove",
        );
      },
    },
  ],
});

export { handleRolePanelButtonInteraction } from "./functions/handlers.js";
export { ROLE_PANEL_PREFIX } from "./defaultOverrides.js";
