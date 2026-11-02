import type { Client, Guild } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { embedField, memberAccentColor, type ContainerField, type ResultContainer } from "../../../core/embeds.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { describeAction } from "./actions.js";
import { ACTION_LABELS, formatMinutes, LEAVE_LABELS, STATUS_DOTS, unix, type LeaveKind, type TeamActionType, type TeamStatus } from "./config.js";
import { teamCard } from "./messages.js";
import { historyCutoff } from "./oneGate.js";
import { checklistProgress } from "./onboarding.js";
import { periodLabel, type PeriodRange } from "./periods.js";
import type { QuotaKey } from "./quota.js";
import { metricsLine, quotaIcon } from "./reports.js";
import { shiftWorkedSeconds } from "./shiftMath.js";
import { getActiveShift, getOpenLeave, listActions, listFeedback, listNotes } from "./store.js";
import type { TeamMemberSummary } from "./team.js";

export const STATUS_LABELS: Record<TeamStatus, string> = {
  on_duty: "On duty",
  on_break: "On break",
  off_duty: "Off duty",
  loa: "On leave of absence",
  ra: "On reduced activity",
  suspended: "Suspended",
};

const QUOTA_LABELS: Record<QuotaKey, (n: number) => string> = {
  shift_hours: (n) => `${n}h on shift`,
  mod_actions: (n) => `${n} mod actions`,
  tickets: (n) => `${n} tickets`,
  messages: (n) => `${n} staff messages`,
  voice_hours: (n) => `${n}h in voice`,
  points: (n) => `${n} points`,
};

/** "✅ Met · 6h on shift, 10 mod actions" / "No quota for this rank". */
export function quotaText(summary: TeamMemberSummary): string {
  const keys = Object.keys(summary.quota.required) as QuotaKey[];
  if (keys.length === 0) return "No quota for this rank.";
  const needs = keys.map((key) => QUOTA_LABELS[key](summary.quota.required[key]!)).join(", ");
  const state = summary.quota.excused ? "Excused (on leave)" : summary.quota.met ? "Met" : `${Math.round(summary.quota.progress * 100)}% there`;
  return `${quotaIcon(summary)} ${state}\n-# Needs ${needs}`;
}

/**
 * A staff profile. Everyone who can see it sees rank, status, activity, quota, strikes and the
 * feedback average; managers also see private notes and the full action list.
 */
export function buildProfileCard(
  client: Client,
  guild: Guild,
  guildConfig: GuildConfig,
  config: TeamControlConfig,
  one: boolean,
  summary: TeamMemberSummary,
  range: PeriodRange,
  options: { manager: boolean },
): ResultContainer {
  const member = guild.members.cache.get(summary.userId) ?? null;
  const name = neutralizeMentions(member?.displayName ?? "Former staff member");
  const since = historyCutoff(one);
  const fields: ContainerField[] = [];
  const rank = summary.rankName ? `**${neutralizeMentions(summary.rankName)}**` : "No rank";
  const memberState =
    summary.memberStatus === "terminated" ? " · removed from the team" : summary.memberStatus === "suspended" ? " · suspended" : "";
  fields.push(embedField("Rank", `${rank}${memberState}`, true));
  fields.push(embedField("On the team since", `<t:${unix(summary.joinedAt)}:D>`, true));

  let status = `${STATUS_DOTS[summary.status]} ${STATUS_LABELS[summary.status]}`;
  const shift = getActiveShift(guild.id, summary.userId);
  if (shift) status += ` · ${formatMinutes(shiftWorkedSeconds(shift) / 60)} since <t:${unix(shift.startedAt)}:t>`;
  const leave = getOpenLeave(guild.id, summary.userId);
  if (leave && leave.status !== "pending") {
    status += `\n${LEAVE_LABELS[leave.kind as LeaveKind]} until <t:${unix(leave.endsAt)}:D>`;
  } else if (leave) {
    status += `\nLeave request pending (${LEAVE_LABELS[leave.kind as LeaveKind].toLowerCase()})`;
  }
  fields.push(embedField("Status", status, true));

  fields.push(embedField(periodLabel(range), metricsLine(summary, config.activity.staff_channel_ids.length > 0)));
  fields.push(embedField("Quota", quotaText(summary)));
  const feedback = listFeedback(guild.id, summary.userId, 0, 0, since);
  fields.push(embedField("Strikes", String(summary.activeStrikes), true));
  fields.push(embedField("Feedback", feedback.average === null ? "No ratings yet" : `${feedback.average.toFixed(2)} ★ (${feedback.total})`, true));
  if (summary.trialEndsAt) fields.push(embedField("Trial", `Ends <t:${unix(summary.trialEndsAt)}:R>`, true));
  if (config.onboarding.enabled && config.onboarding.checklist.length > 0) {
    const progress = checklistProgress(guild.id, summary.userId, config);
    fields.push(embedField("Onboarding", `${progress.done}/${progress.total} done`, true));
  }

  const actions = listActions(guild.id, { userId: summary.userId, since }, options.manager ? 8 : 5).rows;
  if (actions.length) {
    fields.push(
      embedField(
        "Recent actions",
        actions
          .map((a) => {
            const label = ACTION_LABELS[a.type as TeamActionType];
            const text = `${label} · ${describeAction(config, a)} · <t:${unix(a.createdAt)}:d>`;
            return a.voidedAt ? `~~${text}~~ (voided)` : text;
          })
          .join("\n"),
      ),
    );
  }
  if (options.manager) {
    const notes = listNotes(guild.id, summary.userId).slice(0, 5);
    fields.push(
      embedField(
        "Manager notes",
        notes.length ? notes.map((n) => `> ${neutralizeMentions(n.body).slice(0, 200)}\n-# <@${n.authorId}> · <t:${unix(n.createdAt)}:d>`).join("\n") : "No notes.",
      ),
    );
  }
  return teamCard(client, guildConfig, `${name}'s team profile`, null, {
    fields,
    thumbnail: member?.displayAvatarURL({ size: 128 }) ?? null,
    color: memberAccentColor(member),
    footer: options.manager ? "Notes are only shown to managers." : null,
  });
}
