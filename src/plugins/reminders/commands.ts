import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { cancelReminder, createReminder, listReminders } from "./functions/store.js";

export const remindCommand: SlashCommandDefinition = {
  plugin: "reminders",
  data: new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set a reminder")
    .addStringOption((o) => o.setName("message").setDescription("Reminder message").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("minutes").setDescription("Minutes from now").setRequired(true).setMinValue(1),
    ),
  execute: async (ctx) => {
    const auth = await requirePluginPermission(ctx, "reminders", "can_create");
    if (!auth) return;

    const message = ctx.interaction.options.getString("message", true);
    const minutes = ctx.interaction.options.getInteger("minutes", true);
    const guildId = ctx.interaction.guildId!;
    const channelId = ctx.interaction.channelId;

    const reminder = await createReminder({
      guildId,
      userId: ctx.interaction.user.id,
      channelId,
      message,
      delayMinutes: minutes,
    });

    await ctx.interaction.reply(
      resultReply(
        "Reminder set",
        `Reminder **#${reminder.id}** set for <t:${Math.floor(reminder.remindAt.getTime() / 1000)}:R>.`,
        ctx.ephemeral,
        slashResultOptions(ctx),
      ),
    );
  },
};

export const remindersCommands: SlashCommandDefinition[] = [
  remindCommand,
  {
    plugin: "reminders",
    data: new SlashCommandBuilder()
      .setName("reminders")
      .setDescription("Manage your reminders")
      .addSubcommand((sub) => sub.setName("list").setDescription("List your reminders"))
      .addSubcommand((sub) =>
        sub
          .setName("cancel")
          .setDescription("Cancel a reminder")
          .addIntegerOption((o) => o.setName("id").setDescription("Reminder ID").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const userId = ctx.interaction.user.id;

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "reminders", "can_list");
        if (!auth) return;

        const rows = await listReminders(guildId, userId);
        if (rows.length === 0) {
          await ctx.interaction.reply(resultReply("Reminders", "You have no active reminders.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const lines = rows.map((row) => {
          const when = `<t:${Math.floor(row.remindAt.getTime() / 1000)}:R>`;
          return `**#${row.id}** ${when}: ${row.message.slice(0, 80)}`;
        });
        await ctx.interaction.reply(resultReply("Your reminders", lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "cancel") {
        const auth = await requirePluginPermission(ctx, "reminders", "can_cancel");
        if (!auth) return;

        const id = ctx.interaction.options.getInteger("id", true);
        const cancelled = await cancelReminder(guildId, userId, id);
        if (!cancelled) {
          await ctx.interaction.reply(resultReply("Not found", `No reminder **#${id}** found.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        await ctx.interaction.reply(resultReply("Reminder cancelled", `Cancelled reminder **#${id}**.`, ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
];
