import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { createCounter, deleteCounter, getCounter, updateCounterValue } from "./functions/store.js";
import { formatCounterMessage, refreshCounterDisplay } from "./functions/handlers.js";

const COUNTER_TYPES = ["members", "messages", "custom"] as const;

export const countersCommands: SlashCommandDefinition[] = [
  {
    plugin: "counters",
    data: new SlashCommandBuilder()
      .setName("counter")
      .setDescription("Manage server counters")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a counter")
          .addStringOption((o) => o.setName("name").setDescription("Counter name").setRequired(true))
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Display channel").addChannelTypes(ChannelType.GuildText).setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName("type")
              .setDescription("Counter type")
              .setRequired(true)
              .addChoices(
                { name: "Members", value: "members" },
                { name: "Messages", value: "messages" },
                { name: "Custom", value: "custom" },
              ),
          )
          .addIntegerOption((o) => o.setName("value").setDescription("Initial value (custom only)").setMinValue(0)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set a custom counter value")
          .addStringOption((o) => o.setName("name").setDescription("Counter name").setRequired(true))
          .addIntegerOption((o) => o.setName("value").setDescription("New value").setRequired(true).setMinValue(0)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a counter")
          .addStringOption((o) => o.setName("name").setDescription("Counter name").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const guild = ctx.interaction.guild!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "counters", "can_create");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const channel = ctx.interaction.options.getChannel("channel", true);
        const type = ctx.interaction.options.getString("type", true);
        if (!COUNTER_TYPES.includes(type as (typeof COUNTER_TYPES)[number])) return;

        const existing = await getCounter(guildId, name);
        if (existing) {
          await ctx.interaction.reply(resultReply("Counter exists", `A counter named **${name}** already exists.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }

        let value = ctx.interaction.options.getInteger("value") ?? 0;
        if (type === "members") {
          value = guild.memberCount;
        } else if (type === "messages") {
          value = 0;
        }

        const textChannel = await guild.channels.fetch(channel.id);
        if (!textChannel?.isTextBased()) {
          await ctx.interaction.reply(resultReply("Invalid channel", "Choose a text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const message = await textChannel.send(formatCounterMessage(name, value, type, ctx.client));
        const counter = await createCounter({
          guildId,
          name,
          channelId: channel.id,
          counterType: type,
          value,
          messageId: message.id,
        });

        await ctx.interaction.reply(
          resultReply("Counter created", `Created **${counter.name}** counter in <#${channel.id}>.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "set") {
        const auth = await requirePluginPermission(ctx, "counters", "can_set");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const value = ctx.interaction.options.getInteger("value", true);
        const counter = await getCounter(guildId, name);
        if (!counter) {
          await ctx.interaction.reply(resultReply("Not found", `No counter named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        if (counter.counterType !== "custom") {
          await ctx.interaction.reply(resultReply("Not custom", `Counter **${name}** is managed automatically (${counter.counterType}).`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        await updateCounterValue(guildId, name, value);
        await refreshCounterDisplay(guild, { ...counter, value }, value);
        await ctx.interaction.reply(resultReply("Counter updated", `Set **${name}** to **${value.toLocaleString()}**.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "counters", "can_delete");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const counter = await getCounter(guildId, name);
        if (!counter) {
          await ctx.interaction.reply(resultReply("Not found", `No counter named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        if (counter.messageId) {
          const channel = await guild.channels.fetch(counter.channelId).catch(() => null);
          if (channel?.isTextBased()) {
            const message = await channel.messages.fetch(counter.messageId).catch(() => null);
            await message?.delete().catch(() => null);
          }
        }

        await deleteCounter(guildId, name);
        await ctx.interaction.reply(resultReply("Counter deleted", `Deleted counter **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
];
