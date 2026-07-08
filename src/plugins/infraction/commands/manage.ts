import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requireInfractionPermission } from "../functions/commandHelpers.js";
import {
  deleteInfraction,
  getInfraction,
  searchInfractions,
  updateInfractionDuration,
  updateInfractionReason,
} from "../functions/infractions.js";
import { buildInfractionEmbed, buildInfractionListEmbed } from "../functions/embeds.js";
import { canEditInfractionDuration, canEditInfractionReason } from "../functions/moderation.js";
import { parseDuration, formatDurationShort } from "../functions/duration.js";
import type { InfractionType, InfractionConfig } from "../../../config/schemas/infraction.js";
import { buildCaseDeleteLog, buildCaseUpdateLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { getInfractionPluginConfig } from "../../../core/guildHelpers.js";

export const manageCommands: SlashCommandDefinition[] = [
  {
    plugin: "infractions",
    data: new SlashCommandBuilder()
      .setName("infraction")
      .setDescription("View and manage infractions")
      .addSubcommand((sub) =>
        sub
          .setName("view")
          .setDescription("View an infraction by ID")
          .addIntegerOption((o) => o.setName("id").setDescription("Infraction ID").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("search")
          .setDescription("Search infractions by ID, user, mod, or reason")
          .addStringOption((o) => o.setName("query").setDescription("Search query (optional)"))
          .addStringOption((o) =>
            o
              .setName("type")
              .setDescription("Filter by infraction type")
              .addChoices(
                { name: "Warn", value: "warn" },
                { name: "Note", value: "note" },
                { name: "Mute", value: "mute" },
                { name: "Temp mute", value: "tempmute" },
                { name: "Unmute", value: "unmute" },
                { name: "Kick", value: "kick" },
                { name: "Ban", value: "ban" },
                { name: "Temp ban", value: "tempban" },
                { name: "Unban", value: "unban" },
                { name: "Softban", value: "softban" },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("reason")
          .setDescription("Edit an infraction reason")
          .addIntegerOption((o) => o.setName("id").setDescription("Infraction ID").setRequired(true))
          .addStringOption((o) => o.setName("reason").setDescription("New reason").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("duration")
          .setDescription("Edit an infraction duration")
          .addIntegerOption((o) => o.setName("id").setDescription("Infraction ID").setRequired(true))
          .addStringOption((o) => o.setName("duration").setDescription("New duration from creation (e.g. 2h)").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete an infraction record")
          .addIntegerOption((o) => o.setName("id").setDescription("Infraction ID").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "view") {
        const auth = await requireInfractionPermission(ctx, "can_view");
        if (!auth) return;
        const id = ctx.interaction.options.getInteger("id", true);
        const record = await getInfraction(guildId, id);
        if (!record) {
          await ctx.interaction.reply(resultReply("Infraction", `No infraction #${id} found.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        const user = await ctx.client.users.fetch(record.userId).catch(() => null);
        const mod = await ctx.client.users.fetch(record.modId).catch(() => null);
        await ctx.interaction.reply(
          embedReply(buildInfractionEmbed(record, ctx.client, { userTag: user?.tag, modTag: mod?.tag, emojis: ctx.guildConfig.emojis }), ctx.ephemeral),
        );
        return;
      }

      if (sub === "search") {
        const auth = await requireInfractionPermission(ctx, "can_view");
        if (!auth) return;
        const query = ctx.interaction.options.getString("query") ?? "";
        const type = ctx.interaction.options.getString("type") ?? undefined;
        const records = await searchInfractions(guildId, query, 15, type);
        const title = `Infraction search${query ? `: ${query}` : ""}${type ? ` (${type})` : ""}`;
        await ctx.interaction.reply(
          embedReply(buildInfractionListEmbed(records, title, ctx.client, ctx.guildConfig.emojis), ctx.ephemeral),
        );
        return;
      }

      if (sub === "reason") {
        const auth = await requireInfractionPermission(ctx, "can_edit_reason");
        if (!auth) return;
        const id = ctx.interaction.options.getInteger("id", true);
        const reason = ctx.interaction.options.getString("reason", true);
        const record = await getInfraction(guildId, id);
        if (!record) {
          await ctx.interaction.reply(resultReply("Infraction", `No infraction #${id} found.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        if (!canEditInfractionReason(ctx.guildConfig, auth.pluginConfig, auth.member, record.modId)) {
          await ctx.interaction.reply(resultReply("Permission denied", "You cannot edit this infraction's reason.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        await updateInfractionReason(guildId, id, reason);
        const pluginConfig = getInfractionPluginConfig(ctx.guildConfig) as InfractionConfig;
        await sendModerationLog(
          ctx.client,
          ctx.guildConfig,
          buildCaseUpdateLog(
            id,
            record.type,
            { id: ctx.interaction.user.id, name: ctx.interaction.user.username, avatarUrl: ctx.interaction.user.displayAvatarURL({ size: 128 }) },
            `reason -> ${reason.slice(0, 200)}`,
          ),
          { caseLogOverride: pluginConfig.case_log_channel },
        );
        await ctx.interaction.reply(resultReply("Infraction updated", `Reason for #${id} updated.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "duration") {
        const auth = await requireInfractionPermission(ctx, "can_edit_duration");
        if (!auth) return;
        const id = ctx.interaction.options.getInteger("id", true);
        const durationStr = ctx.interaction.options.getString("duration", true);
        const durationMs = parseDuration(durationStr);
        if (!durationMs) {
          await ctx.interaction.reply(resultReply("Invalid duration", "Use formats like `30m`, `2h`, `1d`.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const record = await getInfraction(guildId, id);
        if (!record) {
          await ctx.interaction.reply(resultReply("Infraction", `No infraction #${id} found.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        if (!canEditInfractionDuration(ctx.guildConfig, auth.pluginConfig, auth.member, record.modId)) {
          await ctx.interaction.reply(resultReply("Permission denied", "You cannot edit this infraction's duration.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        let newType: InfractionType | undefined;
        if (record.type === "mute") newType = "tempmute";
        if (record.type === "ban") newType = "tempban";

        const expiresAt = await updateInfractionDuration(guildId, id, durationMs, newType);
        const pluginConfig = getInfractionPluginConfig(ctx.guildConfig) as InfractionConfig;
        await sendModerationLog(
          ctx.client,
          ctx.guildConfig,
          buildCaseUpdateLog(
            id,
            record.type,
            { id: ctx.interaction.user.id, name: ctx.interaction.user.username, avatarUrl: ctx.interaction.user.displayAvatarURL({ size: 128 }) },
            `duration -> ${durationStr}`,
          ),
          { caseLogOverride: pluginConfig.case_log_channel },
        );
        await ctx.interaction.reply(
          resultReply(
            "Infraction updated",
            `Duration for #${id} set to **${durationStr}** (expires ${formatDurationShort(expiresAt.getTime() - Date.now())}).`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "delete") {
        const auth = await requireInfractionPermission(ctx, "can_delete");
        if (!auth) return;
        const id = ctx.interaction.options.getInteger("id", true);
        const record = await getInfraction(guildId, id);
        if (!record) {
          await ctx.interaction.reply(resultReply("Infraction", `No infraction #${id} found.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        await deleteInfraction(guildId, id);
        const pluginConfig = getInfractionPluginConfig(ctx.guildConfig) as InfractionConfig;
        await sendModerationLog(
          ctx.client,
          ctx.guildConfig,
          buildCaseDeleteLog(id, {
            id: ctx.interaction.user.id,
            name: ctx.interaction.user.username,
            avatarUrl: ctx.interaction.user.displayAvatarURL({ size: 128 }),
          }),
          { caseLogOverride: pluginConfig.case_log_channel },
        );
        await ctx.interaction.reply(resultReply("Infraction deleted", `Infraction #${id} has been deleted.`, ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
];
