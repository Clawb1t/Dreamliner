import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zUtilityConfig } from "../../config/schemas/utility.js";
import { searchCommands } from "./commands/search.js";
import { infoCommands } from "./commands/info.js";
import { moderationCommands } from "./commands/moderation.js";
import { voiceCommands, nicknameCommands } from "./commands/voice.js";
import { metaCommands } from "./commands/meta.js";
import { oneCommands } from "./commands/one.js";
import { snipeCommands } from "./commands/snipe.js";
import { contextMenuCommands } from "./commands/contextMenu.js";
import { configManager } from "../../config/manager.js";
import { getPluginSettings } from "../../core/permissionRoles.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { recordUserMessage } from "./functions/messageCounts.js";
import { handleExpandMessageLinks } from "./functions/expandMessageLinks.js";
import { recordDeletedMessage } from "./functions/snipe.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { sweepExpiredMessageContent } from "../../core/contentRetentionSweep.js";
import { handleGlobalWatchdogMemberAdd } from "./functions/globalWatchdog.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("utility");

export const utilityPlugin = definePlugin({
  name: "utility",
  configSchema: zUtilityConfig,
  slashCommands: [
    ...searchCommands,
    ...infoCommands,
    ...moderationCommands,
    ...voiceCommands,
    ...nicknameCommands,
    ...metaCommands,
    ...oneCommands,
    ...snipeCommands,
  ],
  contextMenuCommands,
  onLoad: async () => {
    registerIntervalTask({
      id: "content-retention:sweep",
      intervalMs: 30 * 60_000,
      run: sweepExpiredMessageContent,
    });
  },
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message;
        if (!msg.guild || msg.author.bot) return;
        const guildConfig = await configManager.getEffectiveConfig(msg.guild.id);
        if (!pluginEnabled(guildConfig, "utility")) return;
        await recordUserMessage(msg.guild.id, msg.author.id).catch(() => null);

        const pluginConfig = getPluginSettings(guildConfig, "utility");
        if (pluginConfig.expand_message_links !== false) {
          await handleExpandMessageLinks(msg).catch(() => null);
        }
      },
    },
    {
      // Feeds /snipe — see functions/snipe.js for why this is its own lightweight, always-on
      // store instead of reusing the logs plugin's message cache (which only exists at all
      // when a server has message logging configured).
      name: Events.MessageDelete,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message | import("discord.js").PartialMessage;
        if (!msg.guild || msg.partial) return;
        const guildConfig = await configManager.getEffectiveConfig(msg.guild.id);
        if (!pluginEnabled(guildConfig, "utility")) return;
        recordDeletedMessage(msg);
      },
    },
    {
      name: Events.ThreadCreate,
      execute: async (_client, thread: unknown) => {
        const t = thread as import("discord.js").AnyThreadChannel;
        if (!t.guild) return;
        const guildConfig = await configManager.getEffectiveConfig(t.guild.id);
        if (!pluginEnabled(guildConfig, "utility")) return;
        const pluginConfig = getPluginSettings(guildConfig, "utility");
        if (pluginConfig.autojoin_threads === false) return;
        if (t.joinable && !t.joined) {
          await t.join().catch(() => null);
        }
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleGlobalWatchdogMemberAdd(member as import("discord.js").GuildMember).catch((err) =>
          log.error("Global Watchdog member-add error:", err),
        );
      },
    },
    {
      name: Events.ThreadListSync,
      execute: async (_client, threads: unknown) => {
        const collection = threads as import("discord.js").Collection<string, import("discord.js").AnyThreadChannel>;
        for (const [, thread] of collection) {
          if (!thread.guild) continue;
          const guildConfig = await configManager.getEffectiveConfig(thread.guild.id);
          if (!pluginEnabled(guildConfig, "utility")) continue;
          const pluginConfig = getPluginSettings(guildConfig, "utility");
          if (pluginConfig.autojoin_threads === false) continue;
          if (thread.joinable && !thread.joined) {
            await thread.join().catch(() => null);
          }
        }
      },
    },
  ],
});
