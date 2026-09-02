import { definePlugin } from "../../core/plugin.js";
import { zRemindersConfig } from "../../config/schemas/plugins.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { remindersCommands } from "./commands.js";
import { processDueReminders } from "./functions/scheduler.js";

export const remindersPlugin = definePlugin({
  name: "reminders",
  configSchema: zRemindersConfig,
  slashCommands: remindersCommands,
  onLoad: async () => {
    registerIntervalTask({
      id: "reminders:due",
      intervalMs: 30_000,
      run: processDueReminders,
    });
  },
});
