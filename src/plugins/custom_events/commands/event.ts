import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import {
  createCustomEvent,
  deleteCustomEvent,
  listCustomEvents,
  parseEventConfigJson,
} from "../functions/store.js";
import { buildDefaultMessageConfig, formatEventConfig } from "../functions/triggers.js";

export const eventCommands: SlashCommandDefinition[] = [
  {
    plugin: "custom_events",
    data: new SlashCommandBuilder()
      .setName("event")
      .setDescription("Manage custom message-triggered events")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a custom event")
          .addStringOption((o) => o.setName("name").setDescription("Event name").setRequired(true))
          .addStringOption((o) => o.setName("match").setDescription("Text to match in messages").setRequired(true))
          .addStringOption((o) => o.setName("response").setDescription("Bot reply when triggered").setRequired(true))
          .addStringOption((o) => o.setName("config").setDescription("Optional JSON config (channels, regex, etc.)")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a custom event")
          .addStringOption((o) => o.setName("name").setDescription("Event name").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List custom events")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "custom_events", "can_create");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true).trim();
        const match = ctx.interaction.options.getString("match", true);
        const response = ctx.interaction.options.getString("response", true);
        const configRaw = ctx.interaction.options.getString("config");

        let config = buildDefaultMessageConfig(match);
        if (configRaw) {
          try {
            config = { ...config, ...parseEventConfigJson(configRaw) };
          } catch {
            await ctx.interaction.reply(
              resultReply("Event", "Invalid JSON in the config option.", ctx.ephemeral, slashResultOptions(ctx)),
            );
            return;
          }
        } else {
          config.match = match;
        }

        const event = await createCustomEvent({
          guildId,
          name,
          triggerType: "message",
          config,
          response,
        });

        await ctx.interaction.reply(
          resultReply("Event created", `Saved **${event.name}** (${formatEventConfig(event.config)}).`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "custom_events", "can_delete");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const deleted = await deleteCustomEvent(guildId, name);
        await ctx.interaction.reply(
          resultReply(
            deleted ? "Event deleted" : "Not found",
            deleted ? `Removed **${name.toLowerCase()}**.` : `No event named **${name}**.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "custom_events", "can_list");
        if (!auth) return;

        const events = await listCustomEvents(guildId);
        if (!events.length) {
          await ctx.interaction.reply(resultReply("Events", "No custom events configured.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const lines = events.map(
          (event) =>
            `**${event.name}** (${event.enabled ? "on" : "off"}) · ${formatEventConfig(event.config)}\nResponse: ${event.response.slice(0, 120)}`,
        );

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Custom events", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Events", trimLines(lines.join("\n\n"))),
            ),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
