import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { TeamControlConfig, TeamRank } from "../../../config/schemas/teamControl.js";
import { embedField } from "../../../core/embeds.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { channelOr, DAY_MS, TEAM_PREFIX, unix } from "./config.js";
import { dmTeamCard, postTeamMessage, teamCard } from "./messages.js";
import { listOnboarding, upsertTeamMember, type TeamMemberRecord } from "./store.js";
import { APP_EMOJI } from "../../../core/appEmojis.js";

export const TRIAL_BUTTON = `${TEAM_PREFIX}trial:`;
export const TRIAL_FAIL_MODAL = `${TEAM_PREFIX}trialfail:`;
export const TRIAL_EXTEND_DAYS = 7;

export type ChecklistProgress = {
  items: Array<{ id: string; label: string; description: string; doneAt: Date | null; doneBy: string | null }>;
  done: number;
  total: number;
};

export function checklistProgress(guildId: string, userId: string, config: TeamControlConfig): ChecklistProgress {
  const done = new Map(listOnboarding(guildId, userId).map((row) => [row.itemId, row]));
  const items = config.onboarding.checklist.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    doneAt: done.get(item.id)?.doneAt ?? null,
    doneBy: done.get(item.id)?.doneBy ?? null,
  }));
  return { items, done: items.filter((item) => item.doneAt).length, total: items.length };
}

export function checklistText(progress: ChecklistProgress): string {
  if (progress.total === 0) return "No checklist is set up.";
  return progress.items
    .map((item) => `${item.doneAt ? APP_EMOJI.correct : APP_EMOJI.square} ${neutralizeMentions(item.label)}${item.description ? `\n-# ${neutralizeMentions(item.description)}` : ""}`)
    .join("\n");
}

/** Whether someone joining at `rank` starts a trial. */
export function startsTrial(config: TeamControlConfig, rank: TeamRank): boolean {
  if (!config.onboarding.enabled || config.onboarding.trial_days <= 0) return false;
  return !config.onboarding.trial_rank_id || config.onboarding.trial_rank_id === rank.id;
}

/** New staff: starts their trial and DMs the welcome with their checklist. */
export async function onJoinTeam(member: GuildMember, config: TeamControlConfig, rank: TeamRank): Promise<void> {
  if (!config.onboarding.enabled) return;
  const trialEndsAt = startsTrial(config, rank) ? new Date(Date.now() + config.onboarding.trial_days * DAY_MS) : null;
  if (trialEndsAt) upsertTeamMember(member.guild.id, member.id, { trialEndsAt, trialReviewedAt: null });
  if (!config.onboarding.dm_welcome) return;
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  const progress = checklistProgress(member.guild.id, member.id, config);
  const fields = [];
  if (progress.total > 0) fields.push(embedField("Your checklist", checklistText(progress)));
  if (trialEndsAt) fields.push(embedField("Trial", `Your trial ends <t:${unix(trialEndsAt)}:D> (<t:${unix(trialEndsAt)}:R>).`));
  await dmTeamCard(
    member.user,
    teamCard(
      member.client,
      guildConfig,
      `Welcome to the ${member.guild.name} team`,
      `You joined as **${neutralizeMentions(rank.name)}**. Use \`/team profile\` to see your progress and \`/team shift start\` when you're on duty.`,
      { tone: "success", fields, thumbnail: member.guild.iconURL({ size: 128 }) },
    ),
  );
}

export function trialReviewRow(userId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${TRIAL_BUTTON}pass:${userId}`).setLabel("Pass").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${TRIAL_BUTTON}extend:${userId}`)
      .setLabel(`Extend ${TRIAL_EXTEND_DAYS} days`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${TRIAL_BUTTON}fail:${userId}`).setLabel("Fail").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

/** Posts the review for a trial that just ended, and marks it posted. */
export async function postTrialReview(client: Client, row: TeamMemberRecord, config: TeamControlConfig): Promise<void> {
  const guild = client.guilds.cache.get(row.guildId);
  upsertTeamMember(row.guildId, row.userId, { trialReviewedAt: new Date() });
  if (!guild || !config.onboarding.enabled) return;
  const channelId = channelOr(config, config.onboarding.review_channel_id);
  if (!channelId) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const progress = checklistProgress(guild.id, row.userId, config);
  const rank = config.ranks.find((r) => r.id === row.rankId);
  await postTeamMessage(
    client,
    guild,
    channelId,
    teamCard(client, guildConfig, "Trial review", `<@${row.userId}>'s trial${rank ? ` as **${neutralizeMentions(rank.name)}**` : ""} has ended. Pass to promote them one rank, extend it, or fail to remove them from the team.`, {
      tone: "warning",
      fields: [
        embedField("On the team since", `<t:${unix(row.joinedAt)}:D>`, true),
        ...(progress.total ? [embedField("Checklist", `${progress.done}/${progress.total} done`, true)] : []),
      ],
    }),
    { rows: [trialReviewRow(row.userId)], pingRoleIds: config.manager_role_ids },
  );
}
