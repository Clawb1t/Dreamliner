import { Events, type GuildMember } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zRaidMeshConfig } from "../../config/schemas/raidMesh.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { sweepExpiredInvites } from "./functions/mesh.js";
import { handleWatchlistMemberAdd, sweepExpiredWatchlist } from "./functions/watchlist.js";

export const raidMeshPlugin = definePlugin({
  name: "raid_mesh",
  configSchema: zRaidMeshConfig,
  slashCommands: [],
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleWatchlistMemberAdd(member as GuildMember);
      },
    },
  ],
  onLoad: async () => {
    registerIntervalTask({
      id: "raid-mesh:sweep-invites",
      intervalMs: 60 * 60_000,
      run: async () => {
        await sweepExpiredInvites();
        await sweepExpiredWatchlist();
      },
    });
  },
});
