import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCountersConfig } from "../../config/schemas/counters.js";
import {
  handleCounterGuildUpdate,
  handleCounterMemberChange,
  handleCounterMessage,
  handleCounterReady,
  runCounterRefreshSweep,
  syncGuildCounters,
} from "./functions/handlers.js";

export const countersPlugin = definePlugin({
  name: "counters",
  configSchema: zCountersConfig,
  slashCommands: [],
  onLoad: async ({ client, configManager }) => {
    configManager.onSave((guildId, config) => {
      void syncGuildCounters(client, guildId, { guildConfig: config }).catch((error) => {
        console.error(`[counters] Failed to apply config for ${guildId}:`, error);
      });
    });

    // Channel/voice-name counters are rate-limit gated per counter (see
    // refresh_minutes), so this can run often — most ticks are a no-op.
    setInterval(() => {
      runCounterRefreshSweep(client).catch((error) => {
        console.error("[counters] Refresh sweep failed:", error);
      });
    }, 60_000);
  },
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        await handleCounterReady(client as import("discord.js").Client);
      },
    },
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
    {
      name: Events.GuildUpdate,
      execute: async (_client, oldGuild: unknown, newGuild: unknown) => {
        await handleCounterGuildUpdate(
          oldGuild as import("discord.js").Guild,
          newGuild as import("discord.js").Guild,
        );
      },
    },
  ],
});
