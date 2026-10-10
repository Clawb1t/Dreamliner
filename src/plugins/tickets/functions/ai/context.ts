import { ChannelType, type Client, type Guild, type GuildMember, type Message, type TextBasedChannel } from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import type { TicketAiConfig } from "../../../../config/schemas/ticketAi.js";
import type { GuildConfig } from "../../../../config/schemas/guild.js";
import type { TicketCategory, TicketsConfig } from "../../../../config/schemas/tickets.js";
import { getDb } from "../../../../db/client.js";
import { modCases } from "../../../../db/schema.js";
import { queryTickets, type TicketRecord } from "../tickets.js";
import { TICKET_AI_PREFIX } from "./ids.js";

/**
 * The default knowledge the AI Responder starts with, read live for every reply (nothing here is
 * stored): the server, the member being helped, their history, and the ticket so far. Each part
 * can be turned off on the dashboard.
 */

const day = (date: Date) => date.toISOString().slice(0, 10);

function ageLabel(from: Date, now = new Date()): string {
  const days = Math.floor((now.getTime() - from.getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export type ChannelRef = { id: string; name: string };

/**
 * Text, announcement and forum channels the member can see (or @everyone, when there's no member),
 * in sidebar order, leaving out ticket channels. Used both to tell the AI which channels exist and
 * to turn a plain "#name" in its reply into a real channel mention.
 */
export function visibleChannels(guild: Guild, member: GuildMember | null, tickets: TicketsConfig, limit = 60): ChannelRef[] {
  const viewer = member ?? guild.roles.everyone;
  const ticketParents = new Set(
    tickets.panels.flatMap((panel) => panel.categories.map((category) => category.category_channel_id)).filter(Boolean),
  );
  const parentPosition = (id: string | null) => (id ? (guild.channels.cache.get(id) as { position?: number } | undefined)?.position ?? 0 : -1);
  return [...guild.channels.cache.values()]
    .filter(
      (c): c is Extract<typeof c, { position: number; parentId: string | null }> =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement || c.type === ChannelType.GuildForum) &&
        !(c.parentId && ticketParents.has(c.parentId)) &&
        Boolean(c.permissionsFor(viewer)?.has("ViewChannel")),
    )
    .sort((a, b) => parentPosition(a.parentId) - parentPosition(b.parentId) || a.position - b.position)
    .slice(0, limit)
    .map((c) => ({ id: c.id, name: c.name }));
}

export function buildServerContext(guild: Guild, guildConfig: GuildConfig, tickets: TicketsConfig, channels: ChannelRef[]): string {
  const lines: string[] = [`Server: ${guild.name} (${guild.memberCount.toLocaleString("en-US")} members)`];
  const description = guildConfig.server_page?.description?.trim() || guild.description?.trim();
  if (description) lines.push(`About: ${description.slice(0, 400)}`);
  if (guild.rulesChannelId) lines.push(`Rules channel: <#${guild.rulesChannelId}>`);

  // The channels this member can see: names help the AI point people to the right place.
  if (channels.length) lines.push(`Channels (mention as written): ${channels.map((c) => `<#${c.id}> = #${c.name}`).join(", ")}`);

  const roles = [...guild.roles.cache.values()]
    .filter((r) => !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .slice(0, 25)
    .map((r) => r.name);
  if (roles.length) lines.push(`Roles (highest first): ${roles.join(", ")}`);

  const categories = tickets.panels.flatMap((panel) =>
    panel.categories.map((c) => `${c.label}${c.description ? `: ${c.description}` : ""}`),
  );
  if (categories.length) lines.push(`Ticket categories: ${[...new Set(categories)].slice(0, 15).join("; ")}`);
  return lines.join("\n");
}

export async function buildMemberContext(
  guild: Guild,
  member: GuildMember | null,
  userId: string,
  config: TicketAiConfig,
  currentTicketId: number,
): Promise<string> {
  const lines: string[] = [];
  if (config.context.member_profile && member) {
    lines.push(`Member: ${member.displayName} (@${member.user.username}, id ${member.id})`);
    lines.push(`Account created ${ageLabel(member.user.createdAt)}${member.joinedAt ? `, joined the server ${ageLabel(member.joinedAt)}` : ""}.`);
    const roles = [...member.roles.cache.values()]
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .slice(0, 15)
      .map((r) => r.name);
    lines.push(`Their roles: ${roles.length ? roles.join(", ") : "none"}.`);
    if (member.premiumSince) lines.push(`Server booster since ${day(member.premiumSince)}.`);
  } else if (config.context.member_profile) {
    lines.push(`Member id: ${userId} (not currently in the server's member list).`);
  }

  if (config.context.member_tickets) {
    const { tickets } = await queryTickets(guild.id, { openerId: userId, limit: 6 }).catch(() => ({ tickets: [] as TicketRecord[] }));
    const past = tickets.filter((t) => t.id !== currentTicketId).slice(0, 5);
    if (past.length) {
      lines.push("Their previous tickets (newest first):");
      for (const t of past) {
        const outcome = t.status === "closed" ? `closed${t.closeReason ? `: ${t.closeReason.slice(0, 120)}` : ""}` : "still open";
        lines.push(`- #${t.number}, opened ${day(t.createdAt)}, ${outcome}`);
      }
    } else {
      lines.push("This is their first ticket.");
    }
  }

  if (config.context.member_cases) {
    const cases = getDb()
      .select({ type: modCases.type, reason: modCases.reason, active: modCases.active, createdAt: modCases.createdAt })
      .from(modCases)
      .where(and(eq(modCases.guildId, guild.id), eq(modCases.userId, userId)))
      .orderBy(desc(modCases.createdAt))
      .limit(5)
      .all();
    if (cases.length) {
      lines.push("Their recent moderation cases (newest first; never reveal who issued them):");
      for (const c of cases) {
        lines.push(`- ${c.type}${c.active ? " (active)" : ""}, ${day(c.createdAt)}${c.reason ? `: ${c.reason.slice(0, 120)}` : ""}`);
      }
    } else {
      lines.push("No moderation cases on record.");
    }
  }
  return lines.join("\n");
}

export type ConversationTurn = { speaker: "member" | "staff" | "assistant"; name: string; text: string };

/** Text of a message, including Components V2 text displays (the bot's own posts have no content). */
export function messageText(message: Message): string {
  const parts: string[] = [];
  if (message.content) parts.push(message.content);
  const walk = (components: readonly unknown[]) => {
    for (const component of components) {
      const c = component as { type?: number; content?: string; components?: unknown[]; data?: { type?: number; content?: string } };
      const content = c.content ?? c.data?.content;
      if (typeof content === "string" && (c.type === 10 || c.data?.type === 10)) parts.push(content);
      if (Array.isArray(c.components)) walk(c.components);
    }
  };
  walk(message.components as unknown as unknown[]);
  for (const embed of message.embeds) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
  }
  if (message.attachments.size) parts.push(`[${message.attachments.size} attachment(s)]`);
  return parts.join("\n").trim();
}

/** Invisible character at the start of every AI post's footer (greeting, replies, hand-off), so
 *  they're recognised even when the label and buttons are turned off. */
export const AI_MARKER = "\u2063";

/** True for the AI Responder's own posts (they carry its marker, buttons or label). */
export function isAiReply(message: Message, client: Client): boolean {
  if (message.author.id !== client.user?.id) return false;
  const text = messageText(message);
  return text.includes(AI_MARKER) || JSON.stringify(message.components).includes(TICKET_AI_PREFIX) || text.includes(AI_LABEL_MARKER);
}

/** Shown on every AI reply (when labels are on), and used to recognise them later. */
export const AI_LABEL_MARKER = "AI-generated response";

/**
 * The ticket's recent conversation, oldest first: member messages, staff messages and the AI's own
 * replies. Other bot posts (the welcome card, logs) are skipped; the form answers are given
 * separately.
 */
export async function readConversation(
  channel: TextBasedChannel,
  client: Client,
  openerId: string,
  staffRoleIds: string[],
  limit = 40,
): Promise<ConversationTurn[]> {
  const messages = await channel.messages.fetch({ limit }).catch(() => null);
  if (!messages) return [];
  const turns: ConversationTurn[] = [];
  for (const message of [...messages.values()].reverse()) {
    if (message.author.bot) {
      if (!isAiReply(message, client)) continue;
      // Drop the footer line (name, label, hand-off reason) and keep what the AI actually said.
      const text = messageText(message)
        .split("\n")
        .filter((line) => !line.includes(AI_MARKER) && !line.includes(AI_LABEL_MARKER))
        .join("\n")
        .trim();
      if (text) turns.push({ speaker: "assistant", name: "you", text: text.slice(0, 2000) });
      continue;
    }
    const text = messageText(message);
    if (!text) continue;
    const member = message.member;
    const staff = message.author.id !== openerId && Boolean(member && staffRoleIds.some((id) => member.roles.cache.has(id)));
    turns.push({
      speaker: message.author.id === openerId ? "member" : staff ? "staff" : "member",
      name: member?.displayName ?? message.author.username,
      text: text.slice(0, 2000),
    });
  }
  return turns;
}

/** Support roles for a ticket's category, falling back to the plugin-wide staff roles. */
export function staffRoleIdsFor(category: TicketCategory | undefined, pluginConfig: TicketsConfig): string[] {
  const roles = category?.support_role_ids.filter(Boolean) ?? [];
  return roles.length ? roles : pluginConfig.staff_role_ids.filter(Boolean);
}
