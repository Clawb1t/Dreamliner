import { SlashCommandBuilder, type GuildMember } from "discord.js";
import type { ActivityMetric, ActivityRewardsConfig } from "../../config/schemas/activityRewards.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import {
  activeMilestones,
  formatCount,
  formatVoiceSeconds,
  hasReached,
  loadActivityRewardsConfig,
  metricValue,
  milestoneLabel,
  PLUGIN,
  requirementLabel,
  type ActivityProgress,
} from "./functions/config.js";
import { processMember } from "./functions/rewards.js";
import { addProgress, getProgress, memberRank, topMembers } from "./functions/store.js";
import { resetMemberRewards } from "./functions/sync.js";

const TRACK_CHOICES = [
  { name: "Messages", value: "messages" },
  { name: "Voice time", value: "voice_minutes" },
] as const;

function progressBar(fraction: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
}

function formatTrackValue(progress: ActivityProgress, metric: ActivityMetric): string {
  return metric === "messages"
    ? `${formatCount(progress.messages)} messages`
    : formatVoiceSeconds(progress.voiceSeconds);
}

function trackSummary(
  ctx: SlashCommandContext,
  config: ActivityRewardsConfig,
  guildId: string,
  progress: ActivityProgress,
  metric: ActivityMetric,
): string | null {
  const { t } = ctx;
  const milestones = activeMilestones(config, metric);
  if (milestones.length === 0) return null;

  const value = metricValue(progress, metric);
  const rank = memberRank(guildId, metric === "messages" ? progress.messages : progress.voiceSeconds, metric);
  const heading =
    metric === "messages"
      ? t("activity_rewards.trackMessages", "Messages")
      : t("activity_rewards.trackVoice", "Voice time");
  const rankText = rank ? ` · #${rank}` : "";
  const lines = [`**${heading}:** ${formatTrackValue(progress, metric)}${rankText}`];

  const next = milestones.find((m) => value < m.threshold);
  if (next) {
    const previous = [...milestones].reverse().find((m) => value >= m.threshold)?.threshold ?? 0;
    const fraction = (value - previous) / Math.max(1, next.threshold - previous);
    lines.push(
      `${progressBar(fraction)} ${Math.floor(fraction * 100)}% → **${milestoneLabel(next)}** (${requirementLabel(next)})`,
    );
  } else {
    lines.push(t("activity_rewards.trackComplete", "✅ Every milestone on this track reached."));
  }
  return lines.join("\n");
}

async function reply(
  ctx: SlashCommandContext,
  title: string,
  body: string,
  tone: "neutral" | "success" | "warning" | "error" = "neutral",
): Promise<void> {
  await ctx.interaction.reply(resultReply(title, body, ctx.ephemeral, slashResultOptions(ctx, { tone })));
}

async function resolveTargetMember(ctx: SlashCommandContext, fallback: GuildMember): Promise<GuildMember | null> {
  const user = ctx.interaction.options.getUser("user");
  if (!user) return fallback;
  return ctx.interaction.guild?.members.fetch(user.id).catch(() => null) ?? null;
}

export const activityRewardsCommands: SlashCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data: new SlashCommandBuilder()
      .setName("rewards")
      .setDescription("Activity milestones and rewards")
      .addSubcommand((sub) =>
        sub
          .setName("progress")
          .setDescription("Show progress towards the next milestones")
          .addUserOption((o) => o.setName("user").setDescription("Member to check (defaults to you)")),
      )
      .addSubcommand((sub) => sub.setName("milestones").setDescription("List every milestone and its rewards"))
      .addSubcommand((sub) =>
        sub
          .setName("top")
          .setDescription("Most active members")
          .addStringOption((o) =>
            o.setName("track").setDescription("Messages or voice time").addChoices(...TRACK_CHOICES),
          ),
      )
      .addSubcommand((sub) => sub.setName("sync").setDescription("Re-apply the milestone roles you've earned"))
      .addSubcommand((sub) =>
        sub
          .setName("adjust")
          .setDescription("Add to (or take from) a member's progress")
          .addUserOption((o) => o.setName("user").setDescription("Member to adjust").setRequired(true))
          .addStringOption((o) =>
            o.setName("track").setDescription("Which track").setRequired(true).addChoices(...TRACK_CHOICES),
          )
          .addIntegerOption((o) =>
            o
              .setName("amount")
              .setDescription("Messages, or voice minutes. Negative to subtract.")
              .setRequired(true)
              .setMinValue(-10_000_000)
              .setMaxValue(10_000_000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("reset")
          .setDescription("Reset a member's progress and remove their milestone roles")
          .addUserOption((o) => o.setName("user").setDescription("Member to reset").setRequired(true)),
      ),
    execute: async (ctx) => {
      const { t } = ctx;
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const title = t("activity_rewards.title", "Activity rewards");
      const config = loadActivityRewardsConfig(ctx.guildConfig);
      const noMilestones = t("activity_rewards.noMilestones", "No activity milestones are set up for this server yet.");

      if (sub === "progress") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_view");
        if (!auth) return;
        const target = await resolveTargetMember(ctx, auth.member);
        if (!target) {
          await reply(ctx, title, t("activity_rewards.memberNotFound", "That member isn't in this server."), "warning");
          return;
        }
        const progress = getProgress(guildId, target.id);
        const tracks = (["messages", "voice_minutes"] as ActivityMetric[])
          .map((metric) => trackSummary(ctx, config, guildId, progress, metric))
          .filter((line): line is string => Boolean(line));
        if (tracks.length === 0) {
          await reply(ctx, title, noMilestones);
          return;
        }
        const all = activeMilestones(config);
        const reached = all.filter((m) => hasReached(progress, m)).length;
        const who = target.id === auth.member.id ? "" : `<@${target.id}>\n\n`;
        const footer = t("activity_rewards.reachedCount", "**{reached}** of **{total}** milestones reached.", {
          reached,
          total: all.length,
        });
        await reply(ctx, title, `${who}${tracks.join("\n\n")}\n\n${footer}`);
        return;
      }

      if (sub === "milestones") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_view");
        if (!auth) return;
        const all = activeMilestones(config);
        if (all.length === 0) {
          await reply(ctx, title, noMilestones);
          return;
        }
        const progress = getProgress(guildId, auth.member.id);
        const lines = all.map((m) => {
          const mark = hasReached(progress, m) ? "✅" : "▫️";
          const roles = m.roles.length > 0 ? ` · ${m.roles.map((id) => `<@&${id}>`).join(", ")}` : "";
          const label = m.name.trim() ? `**${m.name.trim()}** · ${requirementLabel(m)}` : `**${requirementLabel(m)}**`;
          return `${mark} ${label}${roles}`;
        });
        await reply(ctx, t("activity_rewards.milestonesTitle", "Milestones"), lines.join("\n"));
        return;
      }

      if (sub === "top") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_view");
        if (!auth) return;
        const metric = (ctx.interaction.options.getString("track") ?? "messages") as ActivityMetric;
        const rows = topMembers(guildId, metric, 10);
        if (rows.length === 0) {
          await reply(ctx, title, t("activity_rewards.noActivity", "No activity has been tracked yet."));
          return;
        }
        const lines = rows.map((row, i) => `**${i + 1}.** <@${row.userId}> · ${formatTrackValue(row, metric)}`);
        const heading =
          metric === "messages"
            ? t("activity_rewards.topMessagesTitle", "Top chatters")
            : t("activity_rewards.topVoiceTitle", "Top in voice");
        await reply(ctx, heading, lines.join("\n"));
        return;
      }

      if (sub === "sync") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_sync");
        if (!auth) return;
        if (activeMilestones(config).length === 0) {
          await reply(ctx, title, noMilestones);
          return;
        }
        const progress = getProgress(guildId, auth.member.id);
        const result = await processMember(auth.member, config, progress, { resync: true });
        const parts: string[] = [];
        if (result.toAdd.length > 0) {
          parts.push(t("activity_rewards.added", "Added: {roles}", { roles: result.toAdd.map((id) => `<@&${id}>`).join(", ") }));
        }
        if (result.toRemove.length > 0) {
          parts.push(
            t("activity_rewards.removed", "Removed: {roles}", { roles: result.toRemove.map((id) => `<@&${id}>`).join(", ") }),
          );
        }
        await reply(
          ctx,
          t("activity_rewards.syncComplete", "Sync complete"),
          parts.length > 0
            ? parts.join("\n")
            : t("activity_rewards.alreadySynced", "You already have every milestone role you've earned."),
          "success",
        );
        return;
      }

      if (sub === "adjust") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        const target = await resolveTargetMember(ctx, auth.member);
        if (!target || target.user.bot) {
          await reply(ctx, title, t("activity_rewards.memberNotFound", "That member isn't in this server."), "warning");
          return;
        }
        const metric = ctx.interaction.options.getString("track", true) as ActivityMetric;
        const amount = ctx.interaction.options.getInteger("amount", true);
        const progress = addProgress(
          guildId,
          target.id,
          metric === "messages" ? { messages: amount } : { voiceSeconds: amount * 60 },
        );
        // Staff adjustments award silently; the reply lists what changed instead.
        const result = await processMember(target, config, progress, { announce: false, resync: true });
        const lines = [
          t("activity_rewards.adjustedBody", "<@{id}> is now at **{value}**.", {
            id: target.id,
            value: formatTrackValue(progress, metric),
          }),
        ];
        if (result.newlyReached.length > 0) {
          lines.push(
            t("activity_rewards.newlyReached", "Reached: {milestones}", {
              milestones: result.newlyReached.map((m) => `**${milestoneLabel(m)}**`).join(", "),
            }),
          );
        }
        await reply(ctx, t("activity_rewards.adjustedTitle", "Progress adjusted"), lines.join("\n"), "success");
        return;
      }

      if (sub === "reset") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        const target = await resolveTargetMember(ctx, auth.member);
        if (!target) {
          await reply(ctx, title, t("activity_rewards.memberNotFound", "That member isn't in this server."), "warning");
          return;
        }
        const removed = await resetMemberRewards(target, config);
        const body = t("activity_rewards.resetBody", "Reset <@{id}>'s progress.", { id: target.id });
        const rolesLine =
          removed.length > 0
            ? `\n${t("activity_rewards.removed", "Removed: {roles}", { roles: removed.map((id) => `<@&${id}>`).join(", ") })}`
            : "";
        await reply(ctx, t("activity_rewards.resetTitle", "Progress reset"), `${body}${rolesLine}`, "success");
        return;
      }
    },
  },
];
