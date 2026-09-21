import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { formatDuration } from "../../core/datetime.js";
import { activeTiers, loadBoosterRolesConfig } from "./functions/config.js";
import { syncBoosterRoles } from "./functions/apply.js";
import { boostDurationDays, boostDurationMs, isBoosting } from "../../core/boosterStatus.js";

export const boosterRolesCommands: SlashCommandDefinition[] = [
  {
    plugin: "booster_roles",
    data: new SlashCommandBuilder()
      .setName("booster")
      .setDescription("Server booster role tiers")
      .addSubcommand((sub) => sub.setName("roles").setDescription("List the boost-duration role tiers"))
      .addSubcommand((sub) =>
        sub.setName("recheck").setDescription("Recheck your own boost duration against the tiers now"),
      ),
    execute: async (ctx) => {
      const { t } = ctx;
      const sub = ctx.interaction.options.getSubcommand();

      if (sub === "roles") {
        const auth = await requirePluginPermission(ctx, "booster_roles", "can_view");
        if (!auth) return;

        const config = loadBoosterRolesConfig(ctx.guildConfig);
        const tiers = activeTiers(config);

        if (tiers.length === 0) {
          await ctx.interaction.reply(
            resultReply(
              t("booster_roles.title", "Booster roles"),
              t("booster_roles.noTiers", "No booster role tiers are configured for this server."),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const days = boostDurationDays(auth.member);
        const durationMs = boostDurationMs(auth.member);

        const lines = tiers.map((tier) => {
          const qualifies = days !== null && days >= tier.duration_days;
          const label =
            tier.name.trim() ||
            t("booster_roles.tierFallbackLabel", "{days} day tier", { days: tier.duration_days });
          const mark = qualifies ? "✅" : "▫️";
          const boostingLabel =
            tier.duration_days === 1
              ? t("booster_roles.boostingDaySingular", "{days} day boosting", { days: tier.duration_days })
              : t("booster_roles.boostingDayPlural", "{days} days boosting", { days: tier.duration_days });
          return `${mark} **${label}** — <@&${tier.role_id}> — ${boostingLabel}`;
        });

        const status = durationMs !== null
          ? t(
              "booster_roles.boostingFor",
              "You've been boosting for **{duration}**.",
              { duration: formatDuration(durationMs) },
            )
          : t("booster_roles.notBoosting", "You're not currently boosting this server.");

        await ctx.interaction.reply(
          resultReply(
            t("booster_roles.title", "Booster roles"),
            `${lines.join("\n")}\n\n${status}`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "neutral" }),
          ),
        );
        return;
      }

      if (sub === "recheck") {
        const auth = await requirePluginPermission(ctx, "booster_roles", "can_recheck");
        if (!auth) return;

        if (!isBoosting(auth.member)) {
          await ctx.interaction.reply(
            resultReply(
              t("booster_roles.notBoostingTitle", "Not boosting"),
              t(
                "booster_roles.notBoostingRecheck",
                "You're not currently boosting this server, so there's nothing to recheck.",
              ),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        const config = loadBoosterRolesConfig(ctx.guildConfig);
        if (activeTiers(config).length === 0) {
          await ctx.interaction.reply(
            resultReply(
              t("booster_roles.title", "Booster roles"),
              t("booster_roles.noTiers", "No booster role tiers are configured for this server."),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const evaluation = await syncBoosterRoles(auth.member, config);
        const parts: string[] = [];
        if (evaluation.toAdd.length > 0)
          parts.push(
            t("booster_roles.added", "Added: {roles}", {
              roles: evaluation.toAdd.map((id) => `<@&${id}>`).join(", "),
            }),
          );
        if (evaluation.toRemove.length > 0)
          parts.push(
            t("booster_roles.removed", "Removed: {roles}", {
              roles: evaluation.toRemove.map((id) => `<@&${id}>`).join(", "),
            }),
          );

        await ctx.interaction.reply(
          resultReply(
            t("booster_roles.recheckComplete", "Recheck complete"),
            parts.length > 0
              ? parts.join("\n")
              : t(
                  "booster_roles.alreadyCorrect",
                  "You already have the correct booster role for your boost duration.",
                ),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
        return;
      }
    },
  },
];
