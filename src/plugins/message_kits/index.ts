import { Events, type Channel, type Message, type PartialMessage, type ReadonlyCollection, type Snowflake } from "discord.js";
import { zMessageKitsConfig } from "../../config/schemas/messageKits.js";
import { definePlugin } from "../../core/plugin.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { PLUGIN } from "./functions/constants.js";
import { pruneKitPosts, runDueSchedules } from "./functions/jobs.js";
import { getPostByMessage, markChannelPostsDeleted, updatePost } from "./functions/store.js";

/**
 * Message Kits: messages designed on the dashboard, sent and scheduled from there, and edited in
 * place later. No slash commands: everything is driven by the dashboard bridge
 * (src/bridge/webMessageKits.ts); buttons, menus and forms on sent copies are routed in bot.ts.
 */

function forgetMessage(id: string): void {
  const post = getPostByMessage(id);
  if (post && !post.deletedAt) updatePost(post.id, { deletedAt: new Date() });
}

export const messageKitsPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zMessageKitsConfig,
  // Dashboard-driven: top-level slash commands are at 95/100 and message context menus are full.
  slashCommands: [],
  onLoad: async () => {
    registerIntervalTask({ id: "message-kits:schedules", intervalMs: 30_000, run: runDueSchedules });
    registerIntervalTask({ id: "message-kits:prune", intervalMs: 6 * 60 * 60_000, run: pruneKitPosts });
  },
  events: [
    {
      name: Events.MessageDelete,
      execute: async (_client, message: unknown) => {
        const msg = message as Message | PartialMessage;
        if (!msg.guildId) return;
        forgetMessage(msg.id);
      },
    },
    {
      name: Events.MessageBulkDelete,
      execute: async (_client, messages: unknown) => {
        for (const id of (messages as ReadonlyCollection<Snowflake, Message | PartialMessage>).keys()) forgetMessage(id);
      },
    },
    {
      name: Events.ChannelDelete,
      execute: async (_client, channel: unknown) => {
        const ch = channel as Channel;
        if ("guildId" in ch && ch.guildId) markChannelPostsDeleted(ch.guildId, ch.id);
      },
    },
    {
      name: Events.ThreadDelete,
      execute: async (_client, thread: unknown) => {
        const ch = thread as Channel;
        if ("guildId" in ch && ch.guildId) markChannelPostsDeleted(ch.guildId, ch.id);
      },
    },
  ],
});
