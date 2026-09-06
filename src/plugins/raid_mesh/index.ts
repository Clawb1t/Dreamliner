import { definePlugin } from "../../core/plugin.js";
import { zRaidMeshConfig } from "../../config/schemas/raidMesh.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { sweepExpiredInvites } from "./functions/mesh.js";

export const raidMeshPlugin = definePlugin({
  name: "raid_mesh",
  configSchema: zRaidMeshConfig,
  slashCommands: [],
  onLoad: async () => {
    registerIntervalTask({
      id: "raid-mesh:sweep-invites",
      intervalMs: 60 * 60_000,
      run: async () => {
        await sweepExpiredInvites();
      },
    });
  },
});
