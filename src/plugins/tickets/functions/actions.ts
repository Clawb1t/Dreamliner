import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { TicketCategory, TicketPanel, TicketsConfig } from "../../../config/schemas/tickets.js";
import { buildTicketClaimLog, buildTicketCloseLog, buildTicketOpenLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { ticketClaimId, ticketCloseId, ticketDeleteId, ticketUnclaimId } from "../constants.js";
import { isBlacklisted } from "./blacklist.js";
import { addMemberOverwrite, archiveContainer, createTicketContainer, removeMemberOverwrite } from "./channels.js";
import { buildTicketClaimedEmbed, buildTicketClosedEmbed, buildTicketOpenedEmbed } from "./embeds.js";
import { buildTranscript, dmTranscript, postTranscriptLog, saveTranscript } from "./transcripts.js";
import {
  addMember,
  claimTicket,
  closeTicket as closeTicketRow,
  countOpenTicketsForUser,
  createTicket,
  nextTicketNumber,
  removeMember,
  touchActivity,
  unclaimTicket,
  type TicketFormAnswer,
  type TicketRecord,
} from "./tickets.js";

export type CreateTicketResult = { ticket: TicketRecord } | { error: string };

/** Action row attached to a freshly-opened ticket's welcome message. */
export function ticketActionRow(ticketId: number, claimed: boolean): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (!claimed) {
    row.addComponents(new ButtonBuilder().setCustomId(ticketClaimId(ticketId)).setLabel("Claim").setStyle(ButtonStyle.Primary));
  } else {
    row.addComponents(new ButtonBuilder().setCustomId(ticketUnclaimId(ticketId)).setLabel("Unclaim").setStyle(ButtonStyle.Secondary));
  }
  row.addComponents(new ButtonBuilder().setCustomId(ticketCloseId(ticketId)).setLabel("Close").setStyle(ButtonStyle.Danger));
  return row;
}

/** Action row attached to a just-closed ticket's message, letting staff clean up the channel. */
export function ticketClosedActionRow(ticketId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ticketDeleteId(ticketId)).setLabel("Delete ticket").setStyle(ButtonStyle.Danger),
  );
}

export async function createTicketForMember(opts: {
  client: Client;
  guild: Guild;
  member: GuildMember;
  panel: TicketPanel;
  category: TicketCategory;
  guildConfig: GuildConfig;
  pluginConfig: TicketsConfig;
  formResponses?: TicketFormAnswer[];
}): Promise<CreateTicketResult> {
  const { client, guild, member, panel, category, guildConfig, pluginConfig, formResponses } = opts;

  const blocked = await isBlacklisted(guild.id, member);
  if (blocked) {
    return {
      error: pluginConfig.blacklist_notify
        ? `You are blocked from opening tickets in this server${blocked.reason ? `: ${blocked.reason}` : "."}`
        : "You cannot open a ticket right now.",
    };
  }

  const categoryLimit = category.max_open_per_user;
  if (categoryLimit === 0) {
    return { error: "This ticket category is not accepting new tickets right now." };
  }
  const limit = categoryLimit ?? pluginConfig.max_open_tickets_per_user;
  const openCount = await countOpenTicketsForUser(guild.id, member.id);
  if (openCount >= limit) {
    return { error: `You already have ${openCount} open ticket${openCount === 1 ? "" : "s"} (max ${limit}).` };
  }

  const number = await nextTicketNumber(guild.id);
  const staffRoleIds = pluginConfig.staff_role_ids;
  const container = await createTicketContainer(guild, category, member, number, staffRoleIds);
  if (!container) {
    return { error: "Could not create the ticket channel. Check the category's channel configuration." };
  }

  const ticket = await createTicket({
    guildId: guild.id,
    panelId: panel.id,
    categoryId: category.id,
    channelId: container.channelId,
    threadId: container.threadId,
    mode: container.mode,
    openerId: member.id,
    number,
    formResponses: formResponses ?? [],
  });

  const target = container.threadId ?? container.channelId;
  const channel = await client.channels.fetch(target).catch(() => null);
  if (channel?.isTextBased() && "send" in channel) {
    // Notify the opener and any ping roles once (so they get a Discord notification),
    // then delete that message immediately — the notification already fired, but the
    // ticket channel doesn't keep a bare mention message cluttering its history, and
    // the persistent welcome embed below never re-pings on scroll-back/re-render.
    const pingTargets = [`<@${member.id}>`, ...category.ping_role_ids.filter(Boolean).map((id) => `<@&${id}>`)];
    const pingMsg = await channel.send(pingTargets.join(" ")).catch(() => null);
    await pingMsg?.delete().catch(() => null);

    const embed = buildTicketOpenedEmbed(ticket, category, guild, client, guildConfig.emojis);
    await channel
      .send({ embeds: [embed], components: [ticketActionRow(ticket.id, false)] })
      .catch(() => null);
  }

  await sendModerationLog(
    client,
    guildConfig,
    buildTicketOpenLog({
      ticketNumber: ticket.number,
      opener: { id: member.id, name: member.user.username, avatarUrl: member.user.displayAvatarURL({ size: 128 }) },
      category: category.label,
      channel: { id: container.channelId },
    }),
    {
      guildId: guild.id,
      eventType: "ticket_open",
      actorId: member.id,
      channelId: container.channelId,
      caseLogOverride: pluginConfig.log_channel_id,
    },
  );

  return { ticket };
}

export async function performClaim(
  client: Client,
  guildConfig: GuildConfig,
  pluginConfig: TicketsConfig,
  ticket: TicketRecord,
  staffId: string,
): Promise<void> {
  await claimTicket(ticket.guildId, ticket.id, staffId);
  await sendModerationLog(
    client,
    guildConfig,
    buildTicketClaimLog({
      ticketNumber: ticket.number,
      staff: { id: staffId },
      channel: { id: ticket.channelId },
    }),
    {
      guildId: ticket.guildId,
      eventType: "ticket_claim",
      actorId: staffId,
      channelId: ticket.channelId,
      caseLogOverride: pluginConfig.log_channel_id,
    },
  );
}

export async function performUnclaim(ticket: TicketRecord): Promise<void> {
  await unclaimTicket(ticket.guildId, ticket.id);
}

export async function performClose(
  client: Client,
  guild: Guild,
  guildConfig: GuildConfig,
  pluginConfig: TicketsConfig,
  category: TicketCategory | undefined,
  ticket: TicketRecord,
  actorId: string,
  reason?: string | null,
): Promise<{ transcriptId: string | null }> {
  const targetId = ticket.threadId ?? ticket.channelId;
  const channel = await client.channels.fetch(targetId).catch(() => null);

  let transcriptId: string | null = null;
  if (channel?.isTextBased()) {
    const messages = await buildTranscript(channel).catch(() => []);
    transcriptId = await saveTranscript(ticket.guildId, ticket.id, messages).catch(() => null);
  }

  const closedAt = await closeTicketRow(ticket.guildId, ticket.id, actorId, reason ?? null);
  // `ticket` was fetched before the close landed, so its closedAt is still null — build an
  // up-to-date record for everything below (embeds, transcript log/DM) instead of re-fetching.
  const closedTicket: TicketRecord = {
    ...ticket,
    status: "closed",
    closedAt,
    closedBy: actorId,
    closeReason: reason ?? null,
  };

  if (channel?.isTextBased() && "send" in channel) {
    const embed = buildTicketClosedEmbed(closedTicket, actorId, reason, client, guildConfig.emojis);
    await channel.send({ embeds: [embed], components: [ticketClosedActionRow(ticket.id)] }).catch(() => null);
  }

  const transcriptChannelId = category?.transcript_channel_id || pluginConfig.default_transcript_channel_id;
  if (transcriptId && transcriptChannelId) {
    await postTranscriptLog(client, transcriptChannelId, closedTicket, transcriptId).catch(() => null);
  }

  if (transcriptId && pluginConfig.dm_transcript_on_close) {
    const opener = await client.users.fetch(ticket.openerId).catch(() => null);
    if (opener) await dmTranscript(opener, closedTicket, transcriptId).catch(() => null);
  }

  // `feedback_enabled` (category override, else pluginConfig.feedback_enabled) reserves a spot for
  // a future "rate this ticket" DM; not wired up yet — dm_transcript_on_close covers the transcript DM.

  await archiveContainer(guild, closedTicket);

  await sendModerationLog(
    client,
    guildConfig,
    buildTicketCloseLog({
      ticketNumber: ticket.number,
      actor: { id: actorId },
      channel: { id: ticket.channelId },
      reason,
    }),
    {
      guildId: ticket.guildId,
      eventType: "ticket_close",
      actorId,
      channelId: ticket.channelId,
      caseLogOverride: pluginConfig.log_channel_id,
    },
  );

  return { transcriptId };
}

export async function performAddMember(guild: Guild, ticket: TicketRecord, userId: string): Promise<TicketRecord | null> {
  const updated = await addMember(ticket.guildId, ticket.id, userId);
  if (updated) await addMemberOverwrite(guild, ticket, userId);
  return updated;
}

export async function performRemoveMember(guild: Guild, ticket: TicketRecord, userId: string): Promise<TicketRecord | null> {
  const updated = await removeMember(ticket.guildId, ticket.id, userId);
  if (updated) await removeMemberOverwrite(guild, ticket, userId);
  return updated;
}

export async function bumpActivity(guildId: string, channelId: string): Promise<void> {
  await touchActivity(guildId, channelId);
}

/** Whether a member may close a ticket, given the category's `close_permission` policy. */
export function canCloseTicket(closePermission: string, isOpenerAllowed: boolean, isStaffAllowed: boolean): boolean {
  if (closePermission === "opener") return isOpenerAllowed;
  if (closePermission === "staff") return isStaffAllowed;
  return isOpenerAllowed || isStaffAllowed;
}

export { buildTicketClaimedEmbed };
