import type { GuildMember, MessageCreateOptions, SendableChannels } from "discord.js";
import type {
  ActivityMetric,
  ActivityMilestone,
  ActivityRewardsConfig,
} from "../../../config/schemas/activityRewards.js";
import type { WelcomeEventConfig } from "../../../config/schemas/welcome.js";
import { getLogger } from "../../../core/logger.js";
import { buildDynamicExtras, keysReferencedIn } from "../../../core/templateExtras.js";
import { buildWelcomePayload } from "../../welcome_message/functions/messageBuilder.js";
import {
  activeMilestones,
  formatCount,
  formatVoiceSeconds,
  hasReached,
  milestoneLabel,
  requirementLabel,
  type ActivityProgress,
} from "./config.js";
import { listAwarded, markAwarded } from "./store.js";

const log = getLogger("activity_rewards");
const ROLE_REASON = "Activity Rewards milestone";

// ── Awarded-milestone cache ──────────────────────────────────────────────────
// Every counted message re-checks milestones, so the "already awarded" set is kept in memory
// after the first lookup. Awards only ever grow through markAwarded below, and resets go
// through forgetAwarded, so the cache can't drift from the table.

const awardedCache = new Map<string, Set<number>>();
const AWARDED_CACHE_MAX = 25_000;

function cacheKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function getAwarded(guildId: string, userId: string): Set<number> {
  const key = cacheKey(guildId, userId);
  let set = awardedCache.get(key);
  if (!set) {
    if (awardedCache.size >= AWARDED_CACHE_MAX) awardedCache.clear();
    set = listAwarded(guildId, userId);
    awardedCache.set(key, set);
  }
  return set;
}

export function forgetAwarded(guildId: string, userId?: string): void {
  if (userId) {
    awardedCache.delete(cacheKey(guildId, userId));
    return;
  }
  for (const key of awardedCache.keys()) if (key.startsWith(`${guildId}:`)) awardedCache.delete(key);
}

// ── Role evaluation ──────────────────────────────────────────────────────────

export type RoleDiff = { toAdd: string[]; toRemove: string[] };

/**
 * Which roles a member should gain/lose for the milestones they've reached. Stacking keeps every
 * reached milestone's roles; non-stacking keeps only the highest reached milestone's roles on each
 * track (messages and voice are separate ladders). `remove_roles` of every reached milestone are
 * taken away unless another reached milestone grants the same role.
 */
export function evaluateRoles(
  member: GuildMember,
  config: ActivityRewardsConfig,
  progress: ActivityProgress,
): RoleDiff {
  const wanted = new Set<string>();
  const unwanted = new Set<string>();

  for (const metric of ["messages", "voice_minutes"] as ActivityMetric[]) {
    const reached = activeMilestones(config, metric).filter((m) => hasReached(progress, m));
    if (reached.length === 0) continue;
    const keep = config.stacking ? reached : [reached[reached.length - 1]!];
    for (const m of keep) for (const id of m.roles) wanted.add(id);
    for (const m of reached) {
      for (const id of m.remove_roles) unwanted.add(id);
      if (!config.stacking && !keep.includes(m)) for (const id of m.roles) unwanted.add(id);
    }
  }

  const held = member.roles.cache;
  const toAdd = [...wanted].filter((id) => !held.has(id) && member.guild.roles.cache.has(id));
  const toRemove = [...unwanted].filter((id) => !wanted.has(id) && held.has(id));
  return { toAdd, toRemove };
}

async function applyRoleDiff(member: GuildMember, diff: RoleDiff): Promise<void> {
  if (diff.toAdd.length > 0) {
    await member.roles.add(diff.toAdd, ROLE_REASON).catch((err) => {
      log.warn(`Could not add milestone roles in ${member.guild.id}: ${err instanceof Error ? err.message : err}`);
    });
  }
  if (diff.toRemove.length > 0) {
    await member.roles.remove(diff.toRemove, ROLE_REASON).catch((err) => {
      log.warn(`Could not remove milestone roles in ${member.guild.id}: ${err instanceof Error ? err.message : err}`);
    });
  }
}

// ── Announcements ────────────────────────────────────────────────────────────

/** {milestone}/{messages}/... template vars for one milestone and a member's progress. */
export function milestoneTemplateVars(
  config: ActivityRewardsConfig,
  milestone: ActivityMilestone,
  progress: ActivityProgress,
): Record<string, string> {
  const next = activeMilestones(config, milestone.metric).find((m) => m.threshold > milestone.threshold);
  return {
    milestone: milestoneLabel(milestone),
    milestone_name: milestone.name.trim(),
    milestone_requirement: requirementLabel(milestone),
    messages: formatCount(progress.messages),
    voice_time: formatVoiceSeconds(progress.voiceSeconds),
    voice_hours: (Math.floor(progress.voiceSeconds / 360) / 10).toString(),
    reward_roles: milestone.roles.map((id) => `<@&${id}>`).join(", "),
    next_milestone: next ? milestoneLabel(next) : "",
  };
}

/** The message body (default announcement or the milestone's own) as a welcomer event. */
export function resolveAnnouncementBody(config: ActivityRewardsConfig, milestone: ActivityMilestone): WelcomeEventConfig {
  const body = milestone.message_mode === "custom" ? milestone.message : config.announcement;
  return { enabled: true, content: body.content, embed: body.embed, card: body.card };
}

/** Whether reaching this milestone posts anything at all. */
export function milestoneAnnounces(config: ActivityRewardsConfig, milestone: ActivityMilestone): boolean {
  if (!milestone.announce) return false;
  return milestone.message_mode === "custom" || config.announcement.enabled;
}

export async function buildAnnouncementPayload(
  member: GuildMember,
  config: ActivityRewardsConfig,
  milestone: ActivityMilestone,
  progress: ActivityProgress,
): Promise<MessageCreateOptions | null> {
  const body = resolveAnnouncementBody(config, milestone);
  const dynamicKeys = keysReferencedIn(
    body.content,
    body.embed.title,
    body.embed.description,
    body.embed.footer_text,
    ...body.embed.fields.flatMap((f) => [f.name, f.value]),
    body.card.greeting_text,
    body.card.subtitle_text,
  );
  const extra = {
    ...(await buildDynamicExtras(member, dynamicKeys)),
    ...milestoneTemplateVars(config, milestone, progress),
  };
  const built = await buildWelcomePayload(body, {
    guildId: member.guild.id,
    member,
    user: member.user,
    guild: member.guild,
    extra,
  });
  if (built.empty) return null;
  // Only ever ping the member who reached it, never the reward roles listed in {reward_roles}.
  return { ...built.payload, allowedMentions: { users: [member.id] } };
}

export type AnnouncementTarget = { kind: "dm" } | { kind: "channel"; channelId: string };

export function resolveAnnouncementTarget(
  config: ActivityRewardsConfig,
  milestone: ActivityMilestone,
  activityChannelId?: string | null,
): AnnouncementTarget | null {
  const override = milestone.channel_id?.trim();
  if (override) return { kind: "channel", channelId: override };
  const { destination, channel_id } = config.announcement;
  if (destination === "dm") return { kind: "dm" };
  const channelId = (destination === "current" ? activityChannelId : null) || channel_id?.trim();
  return channelId ? { kind: "channel", channelId } : null;
}

export async function sendAnnouncement(
  member: GuildMember,
  config: ActivityRewardsConfig,
  milestone: ActivityMilestone,
  progress: ActivityProgress,
  activityChannelId?: string | null,
): Promise<{ ok: boolean; detail: string }> {
  const target = resolveAnnouncementTarget(config, milestone, activityChannelId);
  if (!target) return { ok: false, detail: "No announcement channel is set." };

  const payload = await buildAnnouncementPayload(member, config, milestone, progress);
  if (!payload) return { ok: false, detail: "The announcement has no content, embed, or card." };

  if (target.kind === "dm") {
    const sent = await member.send(payload).catch(() => null);
    return sent ? { ok: true, detail: "Sent to your DMs." } : { ok: false, detail: "Couldn't DM that member." };
  }

  const channel = await member.guild.channels.fetch(target.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    return { ok: false, detail: "The announcement channel is missing or isn't a text channel." };
  }
  const sent = await (channel as SendableChannels).send(payload).catch(() => null);
  return sent
    ? { ok: true, detail: `Sent to <#${target.channelId}>.` }
    : { ok: false, detail: `Couldn't post in <#${target.channelId}>. Check my permissions there.` };
}

// ── Processing ───────────────────────────────────────────────────────────────

export type ProcessResult = RoleDiff & { newlyReached: ActivityMilestone[] };

/**
 * Awards any milestones the member has newly reached: applies roles, records the award, and posts
 * one announcement per track (the highest newly reached milestone, so adding several milestones
 * at once never floods a channel). `resync` also re-applies roles for milestones already awarded
 * (used by /rewards sync and the dashboard import), and `announce: false` awards silently.
 */
export async function processMember(
  member: GuildMember,
  config: ActivityRewardsConfig,
  progress: ActivityProgress,
  options: { activityChannelId?: string | null; announce?: boolean; resync?: boolean } = {},
): Promise<ProcessResult> {
  const reached = activeMilestones(config).filter((m) => hasReached(progress, m));
  const empty: ProcessResult = { toAdd: [], toRemove: [], newlyReached: [] };
  if (reached.length === 0 && !options.resync) return empty;

  const awarded = getAwarded(member.guild.id, member.id);
  const newlyReached = reached.filter((m) => !awarded.has(m.id));
  if (newlyReached.length === 0 && !options.resync) return empty;

  const diff = evaluateRoles(member, config, progress);
  await applyRoleDiff(member, diff);

  if (newlyReached.length > 0) {
    markAwarded(member.guild.id, member.id, newlyReached.map((m) => m.id));
    for (const m of newlyReached) awarded.add(m.id);
  }

  if (options.announce !== false) {
    for (const metric of ["messages", "voice_minutes"] as ActivityMetric[]) {
      const top = newlyReached.filter((m) => m.metric === metric).at(-1);
      if (!top || !milestoneAnnounces(config, top)) continue;
      await sendAnnouncement(member, config, top, progress, options.activityChannelId).catch(() => null);
    }
  }

  return { ...diff, newlyReached };
}
