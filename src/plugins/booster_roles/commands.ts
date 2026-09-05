import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { formatDuration } from "../../core/datetime.js";
import { activeTiers, loadBoosterRolesConfig } from "./functions/config.js";
import { boostDurationDays, syncBoosterRoles } from "./functions/apply.js";

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
      const sub = ctx.interaction.options.getSubcommand();

      if (sub === "roles") {
        const auth = await requirePluginPermission(ctx, "booster_roles", "can_view");
        if (!auth) return;

        const config = loadBoosterRolesConfig(ctx.guildConfig);
        const tiers = activeTiers(config);

        if (tiers.length === 0) {
          await ctx.interaction.reply(
            resultReply(
              "Booster roles",
              "No booster role tiers are configured for this server.",
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const premiumSince = auth.member.premiumSince;
        const days = premiumSince ? boostDurationDays(premiumSince) : null;

        const lines = tiers.map((tier) => {
          const qualifies = days !== null && days >= tier.duration_days;
          const label = tier.name.trim() || `${tier.duration_days} day tier`;
          const mark = qualifies ? "✅" : "▫️";
          return `${mark} **${label}** — <@&${tier.role_id}> — ${tier.duration_days} day${tier.duration_days === 1 ? "" : "s"} boosting`;
        });

        const status = premiumSince
          ? `You've been boosting for **${formatDuration(Date.now() - premiumSince.getTime())}**.`
          : "You're not currently boosting this server.";

        await ctx.interaction.reply(
          resultReply(
            "Booster roles",
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

        if (!auth.member.premiumSince) {
          await ctx.interaction.reply(
            resultReply(
              "Not boosting",
              "You're not currently boosting this server, so there's nothing to recheck.",
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
              "Booster roles",
              "No booster role tiers are configured for this server.",
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const evaluation = await syncBoosterRoles(auth.member, config);
        const parts: string[] = [];
        if (evaluation.toAdd.length > 0) parts.push(`Added: ${evaluation.toAdd.map((id) => `<@&${id}>`).join(", ")}`);
        if (evaluation.toRemove.length > 0) parts.push(`Removed: ${evaluation.toRemove.map((id) => `<@&${id}>`).join(", ")}`);

        await ctx.interaction.reply(
          resultReply(
            "Recheck complete",
            parts.length > 0 ? parts.join("\n") : "You already have the correct booster role for your boost duration.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
        return;
      }
    },
  },
];
