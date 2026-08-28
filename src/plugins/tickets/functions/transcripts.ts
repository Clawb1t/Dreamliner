import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Message, TextBasedChannel, User } from "discord.js";
import { getDb } from "../../../db/client.js";
import { ticketTranscripts } from "../../../db/schema.js";
import { buildTranscriptEmbed } from "./embeds.js";
import type { TicketRecord } from "./tickets.js";

export type TranscriptMessage = {
  id: string;
  authorId: string;
  authorTag: string;
  content: string;
  createdAt: string;
  attachments: { name: string; url: string }[];
};

const PAGE_SIZE = 100;
const MAX_MESSAGES = 2000;

/** Paginates backwards through a channel's full history and returns it in chronological order. */
export async function buildTranscript(channel: TextBasedChannel): Promise<TranscriptMessage[]> {
  const collected: Message[] = [];
  let before: string | undefined;

  while (collected.length < MAX_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || batch.size === 0) break;
    collected.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < PAGE_SIZE) break;
  }

  collected.reverse();
  return collected.map((message) => ({
    id: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
  }));
}

export async function saveTranscript(guildId: string, ticketId: number, messages: TranscriptMessage[]): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  await db.insert(ticketTranscripts).values({
    id,
    ticketId,
    guildId,
    createdAt: new Date(),
    payload: JSON.stringify(messages),
  });
  return id;
}

export async function getTranscript(id: string): Promise<TranscriptMessage[] | null> {
  const db = getDb();
  const row = await db.select().from(ticketTranscripts).where(eq(ticketTranscripts.id, id)).get();
  if (!row) return null;
  return JSON.parse(row.payload) as TranscriptMessage[];
}

export async function getLatestTranscriptForTicket(guildId: string, ticketId: number): Promise<{ id: string; messages: TranscriptMessage[] } | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(ticketTranscripts)
    .where(and(eq(ticketTranscripts.guildId, guildId), eq(ticketTranscripts.ticketId, ticketId)));
  const latest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return null;
  return { id: latest.id, messages: JSON.parse(latest.payload) as TranscriptMessage[] };
}

function transcriptToText(ticket: TicketRecord, messages: TranscriptMessage[]): string {
  const lines = [
    `Ticket #${ticket.number} transcript`,
    `Opened by: ${ticket.openerId}`,
    `Status: ${ticket.status}`,
    "",
    ...messages.map((m) => `[${m.createdAt}] ${m.authorTag} (${m.authorId}): ${m.content}${m.attachments.length ? ` [${m.attachments.map((a) => a.url).join(", ")}]` : ""}`),
  ];
  return lines.join("\n");
}

/** DMs a ticket's transcript to a user, with a friendly embed and the full log attached as text. */
export async function dmTranscript(
  user: User,
  ticket: TicketRecord,
  transcriptId: string,
): Promise<boolean> {
  const messages = await getTranscript(transcriptId);
  if (!messages) return false;
  const { AttachmentBuilder } = await import("discord.js");
  const text = transcriptToText(ticket, messages);
  const file = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `ticket-${ticket.number}-transcript.txt` });
  const guild = await user.client.guilds.fetch(ticket.guildId).catch(() => null);
  const embed = buildTranscriptEmbed(ticket, guild?.name ?? "the server", messages.length, user.client, undefined, guild?.iconURL({ size: 64 }));
  try {
    await user.send({ embeds: [embed], files: [file] });
    return true;
  } catch {
    return false;
  }
}

/** Posts a ticket's transcript to a log channel, with a friendly embed and the full log attached as text. */
export async function postTranscriptLog(
  client: import("discord.js").Client,
  channelId: string,
  ticket: TicketRecord,
  transcriptId: string,
): Promise<boolean> {
  const messages = await getTranscript(transcriptId);
  if (!messages) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return false;
  const { AttachmentBuilder } = await import("discord.js");
  const text = transcriptToText(ticket, messages);
  const file = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `ticket-${ticket.number}-transcript.txt` });
  const guild = "guild" in channel ? (channel.guild as import("discord.js").Guild) : null;
  const embed = buildTranscriptEmbed(ticket, guild?.name ?? "this server", messages.length, client, undefined, guild?.iconURL({ size: 64 }));
  await (channel as import("discord.js").TextChannel)
    .send({ embeds: [embed], files: [file] })
    .catch(() => null);
  return true;
}
