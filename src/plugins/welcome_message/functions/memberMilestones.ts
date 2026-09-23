import type { GuildMember, SendableChannels } from "discord.js";
import type {
  WelcomeEventConfig,
  WelcomeMemberMilestone,
  WelcomeMemberMilestones,
} from "../../../config/schemas/welcome.js";
import { buildDynamicExtras, keysReferencedIn } from "../../../core/templateExtras.js";
import { getDb } from "../../../db/client.js";
import { welcomeMemberMilestones } from "../../../db/schema.js";
import { buildWelcomePayload } from "./messageBuilder.js";

export function formatMemberCount(count: number): string {
  return Math.max(0, Math.floor(count)).toLocaleString("en-US");
}

/** {milestone} (e.g. "1,000") and {milestone_name} for a member-count milestone. */
export function memberMilestoneVars(milestone: Pick<WelcomeMemberMilestone, "count" | "name">): Record<string, string> {
  const formatted = formatMemberCount(milestone.count);
  return { milestone: formatted, milestone_name: milestone.name.trim() || `${formatted} members` };
}

/** The shared milestone message or this milestone's own, with its channel resolved. */
export function resolveMemberMilestoneEvent(
  config: WelcomeMemberMilestones,
  milestone: WelcomeMemberMilestone,
): WelcomeEventConfig {
  const body = milestone.message_mode === "custom" ? milestone.message : config;
  return {
    enabled: true,
    channel_id: milestone.channel_id?.trim() || config.channel_id?.trim() || undefined,
    content: body.content,
    embed: body.embed,
    card: body.card,
  };
}

export async function sendMemberMilestone(
  member: GuildMember,
  config: WelcomeMemberMilestones,
  milestone: WelcomeMemberMilestone,
): Promise<{ ok: boolean; detail: string }> {
  const event = resolveMemberMilestoneEvent(config, milestone);
  if (!event.channel_id) return { ok: false, detail: "No milestone channel is set." };

  const keys = keysReferencedIn(
    event.content,
    event.embed.title,
    event.embed.description,
    event.embed.footer_text,
    event.card.greeting_text,
    event.card.subtitle_text,
  );
  const extra = { ...(await buildDynamicExtras(member, keys)), ...memberMilestoneVars(milestone) };
  const built = await buildWelcomePayload(event, {
    guildId: member.guild.id,
    member,
    user: member.user,
    guild: member.guild,
    extra,
  });
  if (built.empty) return { ok: false, detail: "The milestone message has no content, embed, or card." };

  const channel = await member.guild.channels.fetch(event.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    return { ok: false, detail: "The milestone channel is missing or isn't a text channel." };
  }
  const sent = await (channel as SendableChannels).send(built.payload).catch(() => null);
  return sent
    ? { ok: true, detail: `Sent to <#${event.channel_id}>.` }
    : { ok: false, detail: `Couldn't post in <#${event.channel_id}>. Check my permissions there.` };
}

/** Records a milestone as celebrated; false if it already was (so it never fires twice). */
function claimMilestone(guildId: string, memberCount: number): boolean {
  const row = getDb()
    .insert(welcomeMemberMilestones)
    .values({ guildId, memberCount, reachedAt: new Date() })
    .onConflictDoNothing()
    .returning({ memberCount: welcomeMemberMilestones.memberCount })
    .get();
  return Boolean(row);
}

/**
 * Fires when a join brings the server exactly onto a milestone count. Matching the exact count
 * (rather than "at or above") means adding a milestone the server has already passed never
 * triggers a stale celebration, and the claim table stops a dip-and-recover from repeating it.
 * Bots count too, since {member_count} and Discord's own member count include them.
 */
export async function handleMemberMilestoneJoin(member: GuildMember, config: WelcomeMemberMilestones): Promise<void> {
  if (!config.enabled) return;
  const count = member.guild.memberCount;
  const milestone = config.milestones.find((m) => m.enabled !== false && m.count === count);
  if (!milestone || !claimMilestone(member.guild.id, milestone.count)) return;
  await sendMemberMilestone(member, config, milestone).catch(() => null);
}
