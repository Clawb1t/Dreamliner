import type { Client, Guild, GuildMember, PartialGuildMember, User } from "discord.js";
import type { InviteTrackerConfig } from "../../../config/schemas/inviteTracker.js";
import type { WelcomeEventConfig, WelcomeRichMessage } from "../../../config/schemas/welcome.js";
import { configManager } from "../../../config/manager.js";
import { buildResultEmbed, guildResultOptions } from "../../../core/embeds.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { containerReply, pingComponent } from "../../../core/responses.js";
import { buildDynamicExtras, keysReferencedIn } from "../../../core/templateExtras.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { buildWelcomePayload } from "../../welcome_message/functions/messageBuilder.js";
import { describeJoinSource, formatAccountAge, formatCount, type InviteCounts, type JoinSource } from "./config.js";

const log = getLogger("invite_tracker");

export type InviteMessageKind = "join" | "leave" | "unknown";

/** Everything the join/leave templates can show about one join. */
export type InviteMessageFacts = {
  inviterId: string | null;
  inviterName: string | null;
  counts: InviteCounts;
  code: string | null;
  linkName: string | null;
  source: JoinSource;
  joinCount: number;
  accountCreatedAt: number;
};

/** {inviter}/{invites}/{join_source}/... for one join. Every name is mention-neutralized. */
export function inviteTemplateVars(facts: InviteMessageFacts, now = Date.now()): Record<string, string> {
  const inviterName = facts.inviterName ? neutralizeMentions(facts.inviterName) : null;
  const linkName = facts.linkName ? neutralizeMentions(facts.linkName) : null;
  return {
    inviter: facts.inviterId ? `<@${facts.inviterId}>` : "someone",
    inviter_name: inviterName ?? "someone",
    inviter_id: facts.inviterId ?? "",
    invites: formatCount(facts.counts.total),
    invites_regular: formatCount(facts.counts.regular),
    invites_left: formatCount(facts.counts.left),
    invites_fake: formatCount(facts.counts.fake),
    invites_bonus: formatCount(facts.counts.bonus),
    invite_code: facts.code ?? "",
    invite_link_name: linkName ?? "",
    join_source: describeJoinSource(facts.source, { inviterName, linkName }),
    join_count: formatCount(facts.joinCount),
    account_age: formatAccountAge(facts.accountCreatedAt, now),
  };
}

/** Sample vars for the dashboard preview. */
export function sampleInviteVars(kind: InviteMessageKind, viewerName: string): Record<string, string> {
  return inviteTemplateVars({
    inviterId: kind === "unknown" ? null : "000000000000000000",
    inviterName: kind === "unknown" ? null : viewerName,
    counts: { regular: 14, left: 2, fake: 1, bonus: 1, total: 12 },
    code: kind === "unknown" ? null : "dreamliner",
    linkName: kind === "unknown" ? "Twitter bio" : null,
    source: kind === "unknown" ? "tracked" : "invite",
    joinCount: 1,
    accountCreatedAt: Date.now() - 400 * 86_400_000,
  });
}

function asEvent(message: WelcomeRichMessage): WelcomeEventConfig {
  return { enabled: true, content: message.content, embed: message.embed, card: message.card };
}

export function messageFor(config: InviteTrackerConfig, kind: InviteMessageKind): WelcomeRichMessage {
  if (kind === "leave") return config.leave_message.message;
  return kind === "unknown" ? config.join_message.unknown_message : config.join_message.message;
}

async function sendInviteMessage(
  guild: Guild,
  channelId: string | null,
  message: WelcomeRichMessage,
  member: GuildMember | null,
  user: User | null,
  vars: Record<string, string>,
): Promise<void> {
  const channel = await fetchGuildTextChannel(guild.client, guild.id, channelId);
  if (!channel) return;
  const event = asEvent(message);
  const dynamicKeys = keysReferencedIn(
    event.content,
    event.embed.title,
    event.embed.description,
    event.embed.footer_text,
    ...event.embed.fields.flatMap((f) => [f.name, f.value]),
    event.card.greeting_text,
    event.card.subtitle_text,
  );
  const extra = { ...(member ? await buildDynamicExtras(member, dynamicKeys) : {}), ...vars };
  const built = await buildWelcomePayload(event, { guildId: guild.id, member, user, guild, extra });
  if (built.empty) return;
  // Only the member who joined is ever pinged, never the inviter named in {inviter}.
  await channel.send({ ...built.payload, allowedMentions: { users: user ? [user.id] : [] } }).catch((error) => {
    log.warn(`Could not post an invite message in ${guild.id}: ${error instanceof Error ? error.message : error}`);
  });
}

export async function sendJoinMessage(member: GuildMember, config: InviteTrackerConfig, facts: InviteMessageFacts): Promise<void> {
  if (!config.join_message.enabled || !config.join_message.channel_id) return;
  const kind: InviteMessageKind = facts.inviterId ? "join" : "unknown";
  await sendInviteMessage(member.guild, config.join_message.channel_id, messageFor(config, kind), member, member.user, inviteTemplateVars(facts));
}

export async function sendLeaveMessage(
  member: GuildMember | PartialGuildMember,
  config: InviteTrackerConfig,
  facts: InviteMessageFacts,
): Promise<void> {
  if (!config.leave_message.enabled || !config.leave_message.channel_id) return;
  const full = member.partial ? null : (member as GuildMember);
  await sendInviteMessage(member.guild, config.leave_message.channel_id, config.leave_message.message, full, member.user, inviteTemplateVars(facts));
}

/** A plain log entry (or raid alert) in the log channel. `pingRoleId` actually pings that role. */
export async function postInviteLog(
  client: Client,
  guild: Guild,
  config: InviteTrackerConfig,
  title: string,
  body: string,
  options: { tone?: "neutral" | "success" | "warning" | "error"; pingRoleId?: string | null } = {},
): Promise<void> {
  const channel = await fetchGuildTextChannel(client, guild.id, config.log_channel_id);
  if (!channel) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const payload = containerReply(buildResultEmbed(title, body, guildResultOptions(client, guildConfig, { tone: options.tone ?? "neutral" })));
  const roleId = options.pingRoleId && /^\d{17,20}$/.test(options.pingRoleId) ? options.pingRoleId : null;
  const send = roleId
    ? { ...payload, components: [pingComponent(`<@&${roleId}>`), ...payload.components], allowedMentions: { roles: [roleId] } }
    : payload;
  await channel.send(send as Parameters<typeof channel.send>[0]).catch((error) => {
    log.warn(`Could not post an invite log in ${guild.id}: ${error instanceof Error ? error.message : error}`);
  });
}
