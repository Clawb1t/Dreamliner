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

export function buildServerContext(guild: Guild, guildConfig: GuildConfig, tickets: TicketsConfig): string {
  const lines: string[] = [`Server: ${guild.name} (${guild.memberCount.toLocaleString("en-US")} members)`];
  const description = guildConfig.server_page?.description?.trim() || guild.description?.trim();
  if (description) lines.push(`About: ${description.slice(0, 400)}`);
  if (guild.rulesChannelId) lines.push(`Rules channel: <#${guild.rulesChannelId}>`);

  // Public text channels members can see: names help the AI point people to the right place.
  const everyone = guild.roles.everyone;
  const channels = [...guild.channels.cache.values()]
    .filter(
      (c) =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement || c.type === ChannelType.GuildForum) &&
        c.permissionsFor(everyone)?.has("ViewChannel"),
    )
    .sort((a, b) => ("position" in a && "position" in b ? a.position - b.position : 0))
    .slice(0, 40)
    .map((c) => `<#${c.id}> (#${c.name})`);
  if (channels.length) lines.push(`Public channels: ${channels.join(", ")}`);

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

/** True for the AI Responder's own replies (they carry its buttons or label). */
export function isAiReply(message: Message, client: Client): boolean {
  if (message.author.id !== client.user?.id) return false;
  return JSON.stringify(message.components).includes(TICKET_AI_PREFIX) || messageText(message).includes(AI_LABEL_MARKER);
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
      const text = messageText(message).replace(new RegExp(`-# .*${AI_LABEL_MARKER}.*`, "g"), "").trim();
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
