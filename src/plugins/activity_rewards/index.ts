import { Events } from "discord.js";
import { zActivityRewardsConfig } from "../../config/schemas/activityRewards.js";
import { definePlugin } from "../../core/plugin.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { activityRewardsCommands } from "./commands.js";
import { PLUGIN } from "./functions/config.js";
import { handleActivityMessage, tickActivityVoice, VOICE_TICK_MS } from "./functions/tracking.js";

export const activityRewardsPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zActivityRewardsConfig,
  slashCommands: activityRewardsCommands,
  onLoad: async () => {
    registerIntervalTask({
      id: "activity-rewards:voice",
      intervalMs: VOICE_TICK_MS,
      run: tickActivityVoice,
    });
  },
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleActivityMessage(message as import("discord.js").Message);
      },
    },
  ],
});
