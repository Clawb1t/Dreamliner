import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { TicketCategory } from "../../../config/schemas/tickets.js";
import type { TicketRecord } from "./tickets.js";

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const READ = PermissionFlagsBits.ReadMessageHistory;
const ATTACH = PermissionFlagsBits.AttachFiles;

export type TicketContainer = {
  channelId: string;
  threadId: string | null;
  mode: "channel" | "thread";
};

function renderName(pattern: string, vars: { number: number; username: string; category: string }): string {
  return pattern
    .replace(/\{number\}/g, String(vars.number))
    .replace(/\{username\}/g, vars.username)
    .replace(/\{category\}/g, vars.category)
    .slice(0, 90)
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/** Creates the private channel or thread a new ticket lives in, under `category.category_channel_id`. */
export async function createTicketContainer(
  guild: Guild,
  category: TicketCategory,
  opener: GuildMember,
  ticketNumber: number,
  staffRoleIds: string[],
): Promise<TicketContainer | null> {
  const name = renderName(category.naming_pattern || "ticket-{number}", {
    number: ticketNumber,
    username: opener.user.username,
    category: category.label,
  });

  const supportRoles = category.support_role_ids.length ? category.support_role_ids : staffRoleIds;

  if (category.mode === "thread") {
    const parent = await guild.channels.fetch(category.category_channel_id || "").catch(() => null);
    const forumOrText =
      parent && "threads" in parent
        ? parent
        : guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.parentId === category.category_channel_id);
    if (!forumOrText || !("threads" in forumOrText)) return null;
    const thread = await (forumOrText as TextChannel)
      .threads.create({
        name,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Ticket #${ticketNumber} for ${opener.user.tag}`,
      })
      .catch(() => null);
    if (!thread) return null;
    await thread.members.add(opener.id).catch(() => null);
    for (const roleId of supportRoles) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) continue;
      for (const member of role.members.values()) {
        await thread.members.add(member.id).catch(() => null);
      }
    }
    return { channelId: (forumOrText as TextChannel).id, threadId: thread.id, mode: "thread" };
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [VIEW] },
    { id: opener.id, allow: [VIEW, SEND, READ, ATTACH] },
    ...supportRoles.map((roleId) => ({ id: roleId, allow: [VIEW, SEND, READ, ATTACH] })),
  ];

  const channel = await guild.channels
    .create({
      name,
      type: ChannelType.GuildText,
      parent: category.category_channel_id || undefined,
      permissionOverwrites: overwrites,
      reason: `Ticket #${ticketNumber} for ${opener.user.tag}`,
    })
    .catch(() => null);
  if (!channel) return null;
  return { channelId: channel.id, threadId: null, mode: "channel" };
}

export async function addMemberOverwrite(guild: Guild, ticket: TicketRecord, userId: string): Promise<void> {
  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread?.isThread()) await (thread as ThreadChannel).members.add(userId).catch(() => null);
    return;
  }
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (channel && "permissionOverwrites" in channel) {
    await (channel as TextChannel).permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }).catch(() => null);
  }
}

export async function removeMemberOverwrite(guild: Guild, ticket: TicketRecord, userId: string): Promise<void> {
  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread?.isThread()) await (thread as ThreadChannel).members.remove(userId).catch(() => null);
    return;
  }
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (channel && "permissionOverwrites" in channel) {
    await (channel as TextChannel).permissionOverwrites.delete(userId).catch(() => null);
  }
}

/**
 * Closes off a ticket's container without destroying it (archive+lock a thread, or just leave the
 * channel in place) so staff can still read history before/after the transcript step. Hard deletion
 * only happens via the explicit delete action in functions/tickets.ts's deleteTicket + channel.delete.
 */
export async function archiveContainer(guild: Guild, ticket: TicketRecord): Promise<void> {
  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread?.isThread()) {
      await (thread as ThreadChannel).setArchived(true).catch(() => null);
      await (thread as ThreadChannel).setLocked(true).catch(() => null);
    }
    return;
  }
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (channel && "permissionOverwrites" in channel) {
    await (channel as TextChannel).permissionOverwrites.edit(ticket.openerId, { SendMessages: false }).catch(() => null);
  }
}

export async function deleteContainer(guild: Guild, ticket: TicketRecord): Promise<void> {
  if (ticket.threadId) {
    const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
    if (thread) await thread.delete().catch(() => null);
    return;
  }
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (channel) await channel.delete("Ticket deleted").catch(() => null);
}
