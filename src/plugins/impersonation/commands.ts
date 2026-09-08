import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { listAlerts, setAlertStatus, countOpenAlerts } from "./functions/alerts.js";

export const impersonationCommands: SlashCommandDefinition[] = [
  {
    plugin: "impersonation",
    data: new SlashCommandBuilder()
      .setName("impersonation")
      .setDescription("Review detected impersonation alerts")
      .addSubcommand((sub) => sub.setName("list").setDescription("List open alerts"))
      .addSubcommand((sub) =>
        sub
          .setName("resolve")
          .setDescription("Mark an alert resolved (action taken)")
          .addStringOption((o) => o.setName("id").setDescription("Alert id").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("dismiss")
          .setDescription("Mark an alert dismissed (false positive)")
          .addStringOption((o) => o.setName("id").setDescription("Alert id").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      const auth = await requirePluginPermission(ctx, "impersonation", "can_status");
      if (!auth) return;

      if (sub === "list") {
        const [alerts, openCount] = await Promise.all([listAlerts(guildId, { status: "open", limit: 15 }), countOpenAlerts(guildId)]);
        if (!alerts.length) {
          await ctx.interaction.reply(resultReply("Alerts", "No open alerts.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        const lines = alerts.map(
          (a) =>
            `• \`${a.id.slice(0, 8)}\` <@${a.subjectUserId}> looks like **${a.matchedLabel}**` +
            (a.nameSimilarity ? ` (name ${a.nameSimilarity}%)` : "") +
            (a.avatarDistance != null ? ` (avatar Δ${a.avatarDistance})` : ""),
        );
        await ctx.interaction.reply(
          resultReply(`Open alerts (${openCount})`, lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { emoji: "<:icons_warning:1544418156913885194>" })),
        );
        return;
      }

      // sub === "resolve" || sub === "dismiss"
      const id = ctx.interaction.options.getString("id", true);
      const alert = await setAlertStatus(guildId, id, sub === "resolve" ? "resolved" : "dismissed", ctx.interaction.user.id);
      await ctx.interaction.reply(
        resultReply(
          alert ? "Updated" : "Not found",
          alert ? `Alert marked ${sub === "resolve" ? "resolved" : "dismissed"}.` : "No alert with that id.",
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: alert ? undefined : "warning" }),
        ),
      );
    },
  },
];
