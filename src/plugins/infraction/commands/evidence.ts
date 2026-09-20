import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions, deferReplyOptions, replyOrEdit } from "../../../core/responses.js";
import { requireInfractionPermission } from "../functions/commandHelpers.js";
import { captureEvidence } from "../../../core/evidence.js";

export const evidenceCommands: SlashCommandDefinition[] = [
  {
    plugin: "infractions",
    permission: "can_evidence",
    data: new SlashCommandBuilder()
      .setName("evidence")
      .setDescription("Manually capture a member's recent messages as evidence")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Snapshot a member's recent messages into the Evidence page")
          .addUserOption((o) => o.setName("user").setDescription("Member to capture").setRequired(true))
          .addIntegerOption((o) =>
            o
              .setName("count")
              .setDescription("How many recent messages to capture (default 20, max 50)")
              .setMinValue(1)
              .setMaxValue(50),
          ),
      ),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_evidence");
      if (!auth) return;

      if (ctx.interaction.options.getSubcommand() !== "add") return;

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      const user = ctx.interaction.options.getUser("user", true);
      const count = ctx.interaction.options.getInteger("count") ?? 20;

      const captured = await captureEvidence({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        limit: count,
        capturedBy: ctx.interaction.user.id,
        source: "manual",
        caseId: null,
      });

      if (captured === 0) {
        await replyOrEdit(
          ctx.interaction,
          resultReply(
            ctx.t("infraction.evidenceTitle", "Evidence"),
            ctx.t("infraction.noRecentTrackedMessages", "No recent tracked messages found for {user}.", { user: String(user) }),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      await replyOrEdit(
        ctx.interaction,
        resultReply(
          ctx.t("infraction.evidenceTitle", "Evidence"),
          ctx.t(
            "infraction.evidenceCaptured",
            "Captured **{count}** recent message(s) from {user}. View them in the dashboard under Moderation → Evidence.",
            { count: captured, user: String(user) },
          ),
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
];
