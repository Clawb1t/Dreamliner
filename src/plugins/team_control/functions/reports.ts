import type { Client, Guild } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { embedField, type ResultContainer } from "../../../core/embeds.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { channelOr, formatMinutes } from "./config.js";
import { postTeamMessage, teamCard } from "./messages.js";
import { dayKey, periodLabel, periodRange, type PeriodRange, type PeriodWhich } from "./periods.js";
import { summarizeQuotas } from "./quota.js";
import { claimReport } from "./store.js";
import { summarizeTeam, type TeamMemberSummary } from "./team.js";

const REPORT_LINES = 30;

/** "✅ / ❌ / 💤" for one member's quota. */
export function quotaIcon(member: Pick<TeamMemberSummary, "quota">): string {
  if (member.quota.excused) return "💤";
  return member.quota.met ? "✅" : "❌";
}

/** "3h 20m · 12 actions · 4 tickets · 80 msgs · 2h voice" (and points in points mode). */
export function metricsLine(member: Pick<TeamMemberSummary, "metrics">, countsMessages = true): string {
  const m = member.metrics;
  const parts = [`${formatMinutes(m.shiftMinutes)} on shift`, `${m.modActions} actions`, `${m.ticketsClosed} tickets`];
  if (countsMessages) parts.push(`${m.staffMessages} msgs`);
  parts.push(`${formatMinutes(m.voiceMinutes)} voice`);
  if (m.points !== null) parts.push(`**${m.points}** pts`);
  return parts.join(" · ");
}

/** The activity report card for a period: quota totals and one line per member. */
export function buildReportCard(client: Client, guildConfig: GuildConfig, config: TeamControlConfig, members: TeamMemberSummary[], range: PeriodRange): ResultContainer {
  const totals = summarizeQuotas(members.map((m) => m.quota));
  const countsMessages = config.activity.staff_channel_ids.length > 0;
  const lines = members.slice(0, REPORT_LINES).map((m) => {
    const rank = m.rankName ? ` · ${neutralizeMentions(m.rankName)}` : "";
    return `${quotaIcon(m)} <@${m.userId}>${rank}\n-# ${metricsLine(m, countsMessages)}`;
  });
  if (members.length > REPORT_LINES) lines.push(`-# and ${members.length - REPORT_LINES} more on the dashboard`);
  const shift = members.reduce((sum, m) => sum + m.metrics.shiftMinutes, 0);
  return teamCard(client, guildConfig, `Activity report · ${periodLabel(range)}`, lines.length ? lines.join("\n") : "Nobody is on the team.", {
    fields: [
      embedField("Met quota", String(totals.met), true),
      embedField("Missed", String(totals.missed), true),
      embedField("Excused", String(totals.excused), true),
      embedField("Team shift time", formatMinutes(shift), true),
    ],
    footer: "✅ met · ❌ missed · 💤 excused (on leave)",
  });
}

export function reportFor(guild: Guild, config: TeamControlConfig, one: boolean, which: PeriodWhich) {
  const range = periodRange(config.activity.period, config.activity.week_start, which);
  return { range, members: summarizeTeam(guild.id, config, range, one) };
}

/** Scheduled reports (Dreamliner One): posts last period's report once, after it ends. */
export async function postScheduledReport(client: Client, guild: Guild, guildConfig: GuildConfig, config: TeamControlConfig, one: boolean): Promise<boolean> {
  if (!config.activity.enabled || !config.activity.scheduled_reports) return false;
  const channelId = channelOr(config, config.activity.report_channel_id);
  if (!channelId) return false;
  const { range, members } = reportFor(guild, config, one, "previous");
  if (!claimReport(guild.id, dayKey(range.start.getTime()))) return false;
  await postTeamMessage(client, guild, channelId, buildReportCard(client, guildConfig, config, members, range));
  return true;
}
