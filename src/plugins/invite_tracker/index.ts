import { Events, type Client, type Guild, type GuildMember, type Invite, type PartialGuildMember } from "discord.js";
import { zInviteTrackerConfig } from "../../config/schemas/inviteTracker.js";
import { getLogger } from "../../core/logger.js";
import { definePlugin } from "../../core/plugin.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { inviteTrackerCommands, inviteTrackerContextMenus } from "./commands.js";
import { PLUGIN } from "./functions/config.js";
import {
  forgetGuild,
  handleInviteCreate,
  handleInviteDelete,
  handleMemberAdd,
  handleMemberRemove,
  PENDING_SWEEP_MS,
  PRUNE_INTERVAL_MS,
  pruneDisabledCaches,
  pruneOldJoins,
  sweepPendingJoins,
  syncGuildCache,
  warmAllGuilds,
} from "./functions/tracking.js";

const log = getLogger("invite_tracker");

export const inviteTrackerPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zInviteTrackerConfig,
  slashCommands: inviteTrackerCommands,
  contextMenuCommands: inviteTrackerContextMenus,
  onLoad: async ({ client, configManager }) => {
    // Turning the plugin on warms the guild's invite cache; turning it off drops it.
    configManager.onSave((guildId) => {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      void syncGuildCache(guild).catch((error) => {
        log.warn(`Could not sync the invite cache for ${guildId}: ${error instanceof Error ? error.message : error}`);
      });
    });
    registerIntervalTask({
      id: "invite-tracker:pending",
      intervalMs: PENDING_SWEEP_MS,
      run: async () => {
        await sweepPendingJoins();
        await pruneDisabledCaches();
      },
    });
    registerIntervalTask({
      id: "invite-tracker:prune",
      intervalMs: PRUNE_INTERVAL_MS,
      run: pruneOldJoins,
    });
  },
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        await warmAllGuilds(client as Client);
      },
    },
    {
      name: Events.GuildCreate,
      execute: async (_client, guild: unknown) => {
        await syncGuildCache(guild as Guild);
      },
    },
    {
      name: Events.GuildDelete,
      execute: async (_client, guild: unknown) => {
        forgetGuild((guild as Guild).id);
      },
    },
    {
      name: Events.InviteCreate,
      execute: async (_client, invite: unknown) => {
        handleInviteCreate(invite as Invite);
      },
    },
    {
      name: Events.InviteDelete,
      execute: async (_client, invite: unknown) => {
        handleInviteDelete(invite as Invite);
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleMemberAdd(member as GuildMember);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        await handleMemberRemove(member as GuildMember | PartialGuildMember);
      },
    },
  ],
});
