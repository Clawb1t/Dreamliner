import { zBirthdaysConfig } from "../../config/schemas/birthdays.js";
import { definePlugin } from "../../core/plugin.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { birthdaysCommands } from "./commands.js";
import { tickBirthdays } from "./functions/celebrate.js";
import { PLUGIN } from "./functions/config.js";

export const birthdaysPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zBirthdaysConfig,
  slashCommands: birthdaysCommands,
  onLoad: async () => {
    // Birthdays start at a chosen local time in each server's (or member's) timezone, so check
    // every minute; the tick also removes birthday roles and auto-deletes announcements on time.
    registerIntervalTask({
      id: "birthdays:tick",
      intervalMs: 60_000,
      run: (client) => tickBirthdays(client),
    });
  },
});
