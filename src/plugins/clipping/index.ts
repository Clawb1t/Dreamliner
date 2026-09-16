import { Events, type VoiceState } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zClippingConfig } from "../../config/schemas/clipping.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { clippingCommands } from "./commands.js";
import { handleClippingVoiceStateUpdate } from "./functions/emptyChannelWatch.js";
import { sweepExpiredVoiceClips } from "./functions/retentionSweep.js";

export const clippingPlugin = definePlugin({
  name: "clipping",
  configSchema: zClippingConfig,
  slashCommands: clippingCommands,
  onLoad: async () => {
    registerIntervalTask({
      id: "clipping:retention-sweep",
      intervalMs: 60 * 60_000,
      run: sweepExpiredVoiceClips,
    });
  },
  events: [
    {
      name: Events.VoiceStateUpdate,
      execute: async (_client, oldState: unknown, newState: unknown) => {
        handleClippingVoiceStateUpdate(oldState as VoiceState, newState as VoiceState);
      },
    },
  ],
});
