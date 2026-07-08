import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCustomEventsConfig } from "../../config/schemas/plugins.js";
import { customEventsDefaultOverrides } from "./defaultOverrides.js";
import { eventCommands } from "./commands/event.js";
import { getEnabledMessageEvents } from "./functions/store.js";
import { messageMatchesEvent } from "./functions/triggers.js";

export const customEventsPlugin = definePlugin({
  name: "custom_events",
  configSchema: zCustomEventsConfig,
  defaultOverrides: customEventsDefaultOverrides,
  slashCommands: eventCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message;
        if (!msg.guild || msg.author.bot || msg.author.id === msg.client.user?.id) return;

        const events = await getEnabledMessageEvents(msg.guild.id);
        for (const event of events) {
          if (!messageMatchesEvent(msg, event)) continue;
          await msg.reply(event.response).catch(() => null);
          break;
        }
      },
    },
  ],
});
