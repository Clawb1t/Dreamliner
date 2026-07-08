import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zUtilityConfig } from "../../config/schemas/utility.js";
import { utilityDefaultOverrides } from "./defaultOverrides.js";
import { searchCommands } from "./commands/search.js";
import { infoCommands } from "./commands/info.js";
import { moderationCommands } from "./commands/moderation.js";
import { voiceCommands, nicknameCommands } from "./commands/voice.js";
import { metaCommands } from "./commands/meta.js";
import { configManager } from "../../config/manager.js";
import { getUtilityPluginConfig } from "../../core/guildHelpers.js";
import { recordUserMessage } from "./functions/messageCounts.js";

export const utilityPlugin = definePlugin({
  name: "utility",
  configSchema: zUtilityConfig,
  defaultOverrides: utilityDefaultOverrides,
  slashCommands: [
    ...searchCommands,
    ...infoCommands,
    ...moderationCommands,
    ...voiceCommands,
    ...nicknameCommands,
    ...metaCommands,
  ],
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message;
        if (!msg.guild || msg.author.bot) return;
        await recordUserMessage(msg.guild.id, msg.author.id).catch(() => null);
      },
    },
    {
      name: Events.ThreadCreate,
      execute: async (_client, thread: unknown) => {
        const t = thread as import("discord.js").AnyThreadChannel;
        if (!t.guild) return;
        const guildConfig = await configManager.getEffectiveConfig(t.guild.id);
        const pluginConfig = getUtilityPluginConfig(guildConfig);
        if (pluginConfig.autojoin_threads === false) return;
        if (t.joinable && !t.joined) {
          await t.join().catch(() => null);
        }
      },
    },
    {
      name: Events.ThreadListSync,
      execute: async (_client, threads: unknown) => {
        const collection = threads as import("discord.js").Collection<string, import("discord.js").AnyThreadChannel>;
        for (const [, thread] of collection) {
          if (!thread.guild) continue;
          const guildConfig = await configManager.getEffectiveConfig(thread.guild.id);
          const pluginConfig = getUtilityPluginConfig(guildConfig);
          if (pluginConfig.autojoin_threads === false) continue;
          if (thread.joinable && !thread.joined) {
            await thread.join().catch(() => null);
          }
        }
      },
    },
  ],
});
