import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Guild,
  type Message,
  type MessageActionRowComponentBuilder,
  type TextBasedChannel,
  type TextChannel,
  type User,
} from "discord.js";
import { getDb } from "../../../db/client.js";
import { ticketTranscripts } from "../../../db/schema.js";
import { containerReply } from "../../../core/responses.js";
import { getTicketTranscriptUrl } from "../../../core/docsUrl.js";
import { buildTranscriptEmbed } from "./embeds.js";
import type { TicketRecord } from "./tickets.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";

export type TranscriptAttachment = {
  name: string;
  url: string;
  /** Added with web transcripts; older payloads only have name + url. */
  contentType?: string | null;
  size?: number;
  width?: number | null;
  height?: number | null;
};

export type TranscriptEmbed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number | null;
  timestamp?: string;
  author?: { name: string; url?: string; iconUrl?: string };
  fields?: { name: string; value: string; inline: boolean }[];
  footer?: { text: string; iconUrl?: string };
  imageUrl?: string;
  thumbnailUrl?: string;
};

/** One Components V2 container (or loose top-level components), flattened into what a reader sees. */
export type TranscriptComponentBlock = {
  accentColor: number | null;
  items: (
    | { type: "text"; content: string }
    | { type: "image"; url: string }
    | { type: "separator" }
    | { type: "buttons"; buttons: { label: string; url?: string }[] }
  )[];
};

export type TranscriptMessage = {
  id: string;
  authorId: string;
  authorTag: string;
  content: string;
  createdAt: string;
  attachments: TranscriptAttachment[];
  // Everything below was added for the web transcript page — older stored payloads lack it.
  authorName?: string;
  authorAvatar?: string | null;
  authorBot?: boolean;
  editedAt?: string | null;
  embeds?: TranscriptEmbed[];
  components?: TranscriptComponentBlock[];
};

/** Stored payload: old rows are a bare TranscriptMessage[]; new rows carry a little channel context too. */
type StoredTranscriptV2 = { v: 2; channelName: string | null; messages: TranscriptMessage[] };

export type TranscriptRecord = {
  id: string;
  ticketId: number;
  guildId: string;
  createdAt: Date;
  channelName: string | null;
  messages: TranscriptMessage[];
};

const PAGE_SIZE = 100;
const MAX_MESSAGES = 2000;
const MAX_COMPONENT_DEPTH = 6;

/** The bits of a discord.js Message the transcript needs — structural so tests can pass plain objects. */
export type TranscriptSourceMessage = {
  id: string;
  content: string;
  createdAt: Date;
  editedAt?: Date | null;
  author: {
    id: string;
    tag: string;
    username: string;
    globalName?: string | null;
    bot: boolean;
    displayAvatarURL(options?: { size?: number }): string;
  };
  member?: { displayName: string; displayAvatarURL(options?: { size?: number }): string } | null;
  attachments: { values(): Iterable<{ name: string; url: string; contentType?: string | null; size?: number; width?: number | null; height?: number | null }> };
  embeds: readonly { toJSON(): unknown }[];
  components: readonly { toJSON(): unknown }[];
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const url = str(value);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** Discord's raw embed JSON → the stored shape. Returns null for an embed with nothing to show. */
export function mapTranscriptEmbed(raw: unknown): TranscriptEmbed | null {
  if (!isObject(raw)) return null;
  const embed: TranscriptEmbed = {};
  if (str(raw.title)) embed.title = raw.title as string;
  if (str(raw.description)) embed.description = raw.description as string;
  if (httpUrl(raw.url)) embed.url = raw.url as string;
  if (typeof raw.color === "number") embed.color = raw.color;
  if (str(raw.timestamp)) embed.timestamp = raw.timestamp as string;
  if (isObject(raw.author) && str(raw.author.name)) {
    embed.author = {
      name: raw.author.name as string,
      ...(httpUrl(raw.author.url) ? { url: raw.author.url as string } : {}),
      ...(httpUrl(raw.author.icon_url) ? { iconUrl: raw.author.icon_url as string } : {}),
    };
  }
  if (Array.isArray(raw.fields)) {
    const fields = raw.fields
      .filter(isObject)
      .map((f) => ({ name: typeof f.name === "string" ? f.name : "", value: typeof f.value === "string" ? f.value : "", inline: f.inline === true }))
      .filter((f) => f.name || f.value)
      .slice(0, 25);
    if (fields.length) embed.fields = fields;
  }
  if (isObject(raw.footer) && str(raw.footer.text)) {
    embed.footer = {
      text: raw.footer.text as string,
      ...(httpUrl(raw.footer.icon_url) ? { iconUrl: raw.footer.icon_url as string } : {}),
    };
  }
  if (isObject(raw.image) && httpUrl(raw.image.url)) embed.imageUrl = raw.image.url as string;
  if (isObject(raw.thumbnail) && httpUrl(raw.thumbnail.url)) embed.thumbnailUrl = raw.thumbnail.url as string;
  return Object.keys(embed).length ? embed : null;
}

// Raw Components V2 type numbers (discord-api-types ComponentType).
const C_ACTION_ROW = 1;
const C_BUTTON = 2;
const C_SECTION = 9;
const C_TEXT_DISPLAY = 10;
const C_THUMBNAIL = 11;
const C_MEDIA_GALLERY = 12;
const C_SEPARATOR = 14;
const C_CONTAINER = 17;
const BUTTON_STYLE_LINK = 5;

function collectComponentItems(raw: unknown, items: TranscriptComponentBlock["items"], depth: number): void {
  if (!isObject(raw) || depth > MAX_COMPONENT_DEPTH) return;
  switch (raw.type) {
    case C_TEXT_DISPLAY:
      if (str(raw.content)) items.push({ type: "text", content: raw.content as string });
      return;
    case C_SECTION:
      if (Array.isArray(raw.components)) for (const child of raw.components) collectComponentItems(child, items, depth + 1);
      if (isObject(raw.accessory)) collectComponentItems(raw.accessory, items, depth + 1);
      return;
    case C_THUMBNAIL: {
      const url = isObject(raw.media) ? httpUrl(raw.media.url) : undefined;
      if (url) items.push({ type: "image", url });
      return;
    }
    case C_MEDIA_GALLERY:
      if (Array.isArray(raw.items)) {
        for (const item of raw.items) {
          const url = isObject(item) && isObject(item.media) ? httpUrl(item.media.url) : undefined;
          if (url) items.push({ type: "image", url });
        }
      }
      return;
    case C_SEPARATOR:
      items.push({ type: "separator" });
      return;
    case C_ACTION_ROW: {
      const buttons: { label: string; url?: string }[] = [];
      if (Array.isArray(raw.components)) {
        for (const child of raw.components) {
          if (!isObject(child) || child.type !== C_BUTTON) continue;
          const label = str(child.label) ?? (isObject(child.emoji) ? str(child.emoji.name) : undefined);
          if (!label) continue;
          const url = child.style === BUTTON_STYLE_LINK ? httpUrl(child.url) : undefined;
          buttons.push({ label, ...(url ? { url } : {}) });
        }
      }
      if (buttons.length) items.push({ type: "buttons", buttons });
      return;
    }
    case C_BUTTON: {
      // A button as a section accessory.
      const label = str(raw.label);
      if (!label) return;
      const url = raw.style === BUTTON_STYLE_LINK ? httpUrl(raw.url) : undefined;
      items.push({ type: "buttons", buttons: [{ label, ...(url ? { url } : {}) }] });
      return;
    }
    case C_CONTAINER:
      if (Array.isArray(raw.components)) for (const child of raw.components) collectComponentItems(child, items, depth + 1);
      return;
    default:
      return;
  }
}

/** Top-level message components → readable blocks: one per container, loose components grouped together. */
export function mapTranscriptComponents(rawComponents: readonly unknown[]): TranscriptComponentBlock[] {
  const blocks: TranscriptComponentBlock[] = [];
  let loose: TranscriptComponentBlock | null = null;
  for (const raw of rawComponents) {
    if (!isObject(raw)) continue;
    if (raw.type === C_CONTAINER) {
      loose = null;
      const block: TranscriptComponentBlock = {
        accentColor: typeof raw.accent_color === "number" ? raw.accent_color : null,
        items: [],
      };
      collectComponentItems(raw, block.items, 0);
      if (block.items.length) blocks.push(block);
      continue;
    }
    if (!loose) {
      loose = { accentColor: null, items: [] };
      blocks.push(loose);
    }
    collectComponentItems(raw, loose.items, 0);
  }
  return blocks.filter((block) => block.items.length > 0);
}

function safeJson(component: { toJSON(): unknown }): unknown {
  try {
    return component.toJSON();
  } catch {
    return null;
  }
}

/** One Discord message → one stored transcript message (text, author snapshot, attachments, embeds, V2 text). */
export function mapTranscriptMessage(message: TranscriptSourceMessage): TranscriptMessage {
  const embeds = message.embeds.map((embed) => mapTranscriptEmbed(safeJson(embed))).filter((e): e is TranscriptEmbed => e !== null);
  const components = mapTranscriptComponents(message.components.map(safeJson));
  return {
    id: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    authorAvatar: (message.member ?? message.author).displayAvatarURL({ size: 64 }),
    authorBot: message.author.bot,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    attachments: [...message.attachments.values()].map((a) => ({
      name: a.name,
      url: a.url,
      contentType: a.contentType ?? null,
      ...(typeof a.size === "number" ? { size: a.size } : {}),
      width: a.width ?? null,
      height: a.height ?? null,
    })),
    ...(embeds.length ? { embeds } : {}),
    ...(components.length ? { components } : {}),
  };
}

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
  return collected.map((message) => mapTranscriptMessage(message));
}

/** Reads both payload shapes: a bare message array (old rows) or `{ v: 2, channelName, messages }`. */
export function parseTranscriptPayload(payload: string): { channelName: string | null; messages: TranscriptMessage[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { channelName: null, messages: [] };
  }
  if (Array.isArray(parsed)) return { channelName: null, messages: parsed as TranscriptMessage[] };
  if (isObject(parsed) && Array.isArray(parsed.messages)) {
    return { channelName: typeof parsed.channelName === "string" ? parsed.channelName : null, messages: parsed.messages as TranscriptMessage[] };
  }
  return { channelName: null, messages: [] };
}

export async function saveTranscript(
  guildId: string,
  ticketId: number,
  messages: TranscriptMessage[],
  channelName: string | null = null,
): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  const payload: StoredTranscriptV2 = { v: 2, channelName, messages };
  await db.insert(ticketTranscripts).values({
    id,
    ticketId,
    guildId,
    createdAt: new Date(),
    payload: JSON.stringify(payload),
  });
  return id;
}

export async function getTranscript(id: string): Promise<TranscriptMessage[] | null> {
  const db = getDb();
  const row = await db.select().from(ticketTranscripts).where(eq(ticketTranscripts.id, id)).get();
  if (!row) return null;
  return parseTranscriptPayload(row.payload).messages;
}

/** One transcript, only if it belongs to `guildId` — the guild check is what keeps the web page guild-scoped. */
export async function getTranscriptRecord(guildId: string, id: string): Promise<TranscriptRecord | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(ticketTranscripts)
    .where(and(eq(ticketTranscripts.id, id), eq(ticketTranscripts.guildId, guildId)))
    .get();
  if (!row) return null;
  const { channelName, messages } = parseTranscriptPayload(row.payload);
  return { id: row.id, ticketId: row.ticketId, guildId: row.guildId, createdAt: row.createdAt, channelName, messages };
}

export async function getLatestTranscriptForTicket(guildId: string, ticketId: number): Promise<{ id: string; messages: TranscriptMessage[] } | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(ticketTranscripts)
    .where(and(eq(ticketTranscripts.guildId, guildId), eq(ticketTranscripts.ticketId, ticketId)));
  const latest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return null;
  return { id: latest.id, messages: parseTranscriptPayload(latest.payload).messages };
}

/** People who were part of a ticket: the opener, anyone added or claiming it, and anyone who wrote in it. */
export function isTranscriptParticipant(
  viewerId: string,
  ticket: Pick<TicketRecord, "openerId" | "memberIds" | "claimedBy">,
  messages: Pick<TranscriptMessage, "authorId">[],
): boolean {
  if (!viewerId) return false;
  if (ticket.openerId === viewerId || ticket.claimedBy === viewerId) return true;
  if (ticket.memberIds.includes(viewerId)) return true;
  return messages.some((m) => m.authorId === viewerId);
}

function transcriptLinkRow(guildId: string, transcriptId: string, t: Translator): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(t("tickets.embed.viewTranscript", "View transcript"))
      .setStyle(ButtonStyle.Link)
      .setURL(getTicketTranscriptUrl(guildId, transcriptId)),
  );
}

/** DMs a ticket's transcript to a user: a summary card with a link to the web transcript. */
export async function dmTranscript(
  user: User,
  ticket: TicketRecord,
  transcriptId: string,
  t: Translator = defaultTranslator,
): Promise<boolean> {
  const messages = await getTranscript(transcriptId);
  if (!messages) return false;
  const guild = await user.client.guilds.fetch(ticket.guildId).catch(() => null);
  const embed = buildTranscriptEmbed(
    ticket,
    guild?.name ?? t("tickets.embed.theServer", "the server"),
    messages.length,
    user.client,
    undefined,
    guild?.iconURL({ size: 64 }),
    t,
  );
  try {
    await user.send(containerReply(embed, false, [transcriptLinkRow(ticket.guildId, transcriptId, t)]));
    return true;
  } catch {
    return false;
  }
}

/** Posts a ticket's transcript to a log channel: a summary card with a link to the web transcript. */
export async function postTranscriptLog(
  client: Client,
  channelId: string,
  ticket: TicketRecord,
  transcriptId: string,
  t: Translator = defaultTranslator,
): Promise<boolean> {
  const messages = await getTranscript(transcriptId);
  if (!messages) return false;
  const channel = await fetchGuildChannel(client, ticket.guildId, channelId);
  if (!channel?.isTextBased() || !("send" in channel)) return false;
  const guild = "guild" in channel ? (channel.guild as Guild) : null;
  const embed = buildTranscriptEmbed(
    ticket,
    guild?.name ?? t("tickets.embed.thisServer", "this server"),
    messages.length,
    client,
    undefined,
    guild?.iconURL({ size: 64 }),
    t,
  );
  await (channel as TextChannel)
    .send(containerReply(embed, false, [transcriptLinkRow(ticket.guildId, transcriptId, t)]))
    .catch(() => null);
  return true;
}
