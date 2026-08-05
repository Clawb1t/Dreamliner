import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { parseDuration } from "../infraction/functions/duration.js";
import { cancelReminder, createReminder, listReminders } from "./functions/store.js";

function resolveDelayMinutes(ctx: { interaction: { options: { getInteger: (n: string) => number | null; getString: (n: string) => string | null } } }): number | null {
  const minutes = ctx.interaction.options.getInteger("minutes");
  const hours = ctx.interaction.options.getInteger("hours");
  const inRaw = ctx.interaction.options.getString("in")?.trim();

  if (inRaw) {
    const ms = parseDuration(inRaw);
    if (!ms) return null;
    return Math.max(1, Math.round(ms / 60_000));
  }

  const total = (hours ?? 0) * 60 + (minutes ?? 0);
  return total > 0 ? total : null;
}

export const remindCommand: SlashCommandDefinition = {
  plugin: "reminders",
  data: new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set a reminder")
    .addStringOption((o) => o.setName("message").setDescription("Reminder message").setRequired(true))
    .addIntegerOption((o) => o.setName("minutes").setDescription("Minutes from now").setMinValue(1).setMaxValue(525_600))
    .addIntegerOption((o) => o.setName("hours").setDescription("Hours from now").setMinValue(1).setMaxValue(8760))
    .addStringOption((o) => o.setName("in").setDescription("Duration like 30m, 2h, or 1d")),
  execute: async (ctx) => {
    const auth = await requirePluginPermission(ctx, "reminders", "can_create");
    if (!auth) return;

    const message = ctx.interaction.options.getString("message", true);
    const delayMinutes = resolveDelayMinutes(ctx);
    if (!delayMinutes) {
      await ctx.interaction.reply(
        resultReply(
          "Missing time",
          "Provide `minutes`, `hours`, and/or `in` (e.g. `2h`).",
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: "error" }),
        ),
      );
      return;
    }

    const reminder = await createReminder({
      guildId: ctx.interaction.guildId!,
      userId: ctx.interaction.user.id,
      channelId: ctx.interaction.channelId,
      message,
      delayMinutes,
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
