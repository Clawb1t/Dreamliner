import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { deferReplyOptions, embedWithFilesEdit, resultReply, resultEdit, slashResultOptions } from "../../core/responses.js";
import { baseEmbed } from "../../core/embeds.js";
import { isDashboardSuperuser } from "../../bridge/superuser.js";

export const debugCommands: SlashCommandDefinition[] = [
  {
    plugin: "debug",
    data: new SlashCommandBuilder()
      .setName("debug")
      .setDescription("Bot developer diagnostics")
      .addSubcommand((s) =>
        s.setName("appemojis").setDescription("Export every application emoji's markdown to a text file"),
      ),
    execute: async (ctx) => {
      const i = ctx.interaction;
      const sub = i.options.getSubcommand();

      // Bot-wide diagnostic, not a guild feature — restricted to the bot's own developers
      // (the same list the dashboard uses for platform-superuser access), not per-guild admins.
      if (!isDashboardSuperuser(i.user.id)) {
        await i.reply(
          resultReply(
            "Permission denied",
            "This command is restricted to the bot's developers.",
            true,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      if (sub === "appemojis") {
        await i.deferReply(deferReplyOptions(ctx.ephemeral));

        const app = ctx.client.application;
        if (!app) {
          await i.editReply(resultEdit("Not ready", "The bot's application isn't available yet — try again in a moment.", slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const emojis = await app.emojis.fetch();
        if (emojis.size === 0) {
          await i.editReply(resultEdit("No application emojis", "This bot has no application-owned emojis.", slashResultOptions(ctx)));
          return;
        }

        const lines = [...emojis.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")).map((e) => e.toString());
        const file = new AttachmentBuilder(Buffer.from(lines.join("\n"), "utf-8"), { name: "app-emojis.txt" });

        const embed = baseEmbed()
          .setAuthor({ name: "Application emojis", iconURL: ctx.client.user?.displayAvatarURL() })
          .setDescription(`Exported **${emojis.size}** application emoji${emojis.size === 1 ? "" : "s"}.`);
        await i.editReply(embedWithFilesEdit(embed, [file]));
        return;
      }
    },
  },
];
