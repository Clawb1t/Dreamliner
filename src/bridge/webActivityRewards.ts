import type { Client, Guild, GuildMember } from "discord.js";
import {
  zActivityMilestone,
  zActivityRewardsConfig,
  type ActivityMilestone,
  type ActivityRewardsConfig,
} from "../config/schemas/activityRewards.js";
import { configManager } from "../config/manager.js";
import {
  activeMilestones,
  loadActiveActivityRewards,
  loadActivityRewardsConfig,
  type ActivityProgress,
} from "../plugins/activity_rewards/functions/config.js";
import {
  milestoneTemplateVars,
  resolveAnnouncementBody,
  sendAnnouncement,
} from "../plugins/activity_rewards/functions/rewards.js";
import { awardedCounts, guildTotals, importFromStats, topMembers } from "../plugins/activity_rewards/functions/store.js";
import { syncGuildMembers } from "../plugins/activity_rewards/functions/sync.js";
import { buildWelcomePreview } from "./webWelcome.js";

/** The draft config the dashboard sent (so previews/tests reflect unsaved edits), else the saved one. */
async function resolveConfig(guildId: string, draft: unknown): Promise<ActivityRewardsConfig> {
  if (draft != null) {
    const parsed = zActivityRewardsConfig.safeParse(draft);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "Invalid Activity Rewards config.");
    }
    return parsed.data;
  }
  return loadActivityRewardsConfig(await configManager.getEffectiveConfig(guildId));
}

/** The requested milestone, or (for the shared announcement) the first one / a sample. */
function resolveMilestone(config: ActivityRewardsConfig, milestoneId: unknown): ActivityMilestone | null {
  if (typeof milestoneId === "number") return config.milestones.find((m) => m.id === milestoneId) ?? null;
  const first = activeMilestones(config)[0];
  if (first) return { ...first, message_mode: "default", channel_id: undefined };
  return zActivityMilestone.parse({ id: 1, threshold: 1000 });
}

/** Progress exactly at the milestone, so {messages}/{voice_time} read like the real moment. */
function sampleProgress(milestone: ActivityMilestone): ActivityProgress {
  return milestone.metric === "messages"
    ? { messages: milestone.threshold, voiceSeconds: 0 }
    : { messages: 0, voiceSeconds: milestone.threshold * 60 };
}

export async function previewActivityAnnouncement(
  client: Client,
  guild: Guild,
  userId: string,
  body: { config?: unknown; milestoneId?: unknown },
) {
  const config = await resolveConfig(guild.id, body.config);
  const milestone = resolveMilestone(config, body.milestoneId);
  if (!milestone) throw new Error("That milestone doesn't exist.");
  const message = resolveAnnouncementBody(config, milestone);
  return buildWelcomePreview(client, guild, {
    content: message.content,
    embed: message.embed,
    card: message.card,
    sampleUserId: userId,
    extra: milestoneTemplateVars(config, milestone, sampleProgress(milestone)),
  });
}

export async function sendActivityTest(
  guild: Guild,
  member: GuildMember,
  body: { config?: unknown; milestoneId?: unknown },
): Promise<{ ok: boolean; detail: string }> {
  let config: ActivityRewardsConfig;
  try {
    config = await resolveConfig(guild.id, body.config);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Invalid config." };
  }
  const milestone = resolveMilestone(config, body.milestoneId);
  if (!milestone) return { ok: false, detail: "That milestone doesn't exist." };
  // Tests only post the announcement: no roles are granted and nothing is recorded.
  return sendAnnouncement(member, config, milestone, sampleProgress(milestone), null);
}

export type ActivityOverviewMember = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  messages: number;
  voiceSeconds: number;
  milestonesReached: number;
};

export async function getActivityOverview(guild: Guild): Promise<{
  trackedMembers: number;
  milestonesAwarded: number;
  topMessages: ActivityOverviewMember[];
  topVoice: ActivityOverviewMember[];
}> {
  const totals = guildTotals(guild.id);
  const byMessages = topMembers(guild.id, "messages", 10);
  const byVoice = topMembers(guild.id, "voice_minutes", 10);
  const ids = [...new Set([...byMessages, ...byVoice].map((r) => r.userId))];
  const awarded = awardedCounts(guild.id, ids);

  const members = new Map<string, GuildMember | null>();
  const missing = ids.filter((id) => !guild.members.cache.has(id));
  if (missing.length > 0) await guild.members.fetch({ user: missing }).catch(() => null);
  for (const id of ids) members.set(id, guild.members.cache.get(id) ?? null);

  const toMember = (row: (typeof byMessages)[number]): ActivityOverviewMember => {
    const member = members.get(row.userId);
    return {
      userId: row.userId,
      name: member?.displayName ?? `Unknown member (${row.userId})`,
      avatarUrl: member?.displayAvatarURL({ size: 64, extension: "png" }) ?? null,
      messages: row.messages,
      voiceSeconds: row.voiceSeconds,
      milestonesReached: awarded.get(row.userId) ?? 0,
    };
  };

  return {
    trackedMembers: totals.members,
    milestonesAwarded: totals.awarded,
    topMessages: byMessages.map(toMember),
    topVoice: byVoice.map(toMember),
  };
}

/** Backfills progress from Server Stats history, then silently applies any roles now earned. */
export async function importActivityFromStats(
  guild: Guild,
): Promise<{ imported: number; checked: number; rewarded: number }> {
  const imported = importFromStats(guild.id);
  // Roles are only handed out while the plugin is actually on; otherwise this just seeds progress.
  const config = await loadActiveActivityRewards(guild.id);
  if (!config) return { imported, checked: 0, rewarded: 0 };
  const { checked, rewarded } = await syncGuildMembers(guild, config);
  return { imported, checked, rewarded };
}
