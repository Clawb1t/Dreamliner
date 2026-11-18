/**
 * Feed messages. One message design per subscription (text with tokens, an optional card, link
 * buttons). With the card on, the post is Components V2: the text, then a container with the
 * card, its image and the buttons. With the card off it's a plain text message (plus buttons),
 * so Discord's own link preview (a YouTube player, a Twitch stream) shows under it, the way
 * creator notifications always looked.
 */
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  type APIActionRowComponent,
  type APIButtonComponent,
  type BaseMessageOptions,
  type ComponentInContainerData,
  type TopLevelComponentData,
} from "discord.js";
import type { FeedMessage } from "../../../config/schemas/social.js";
import type { FeedItemRow, FeedSourceRow } from "./store.js";
import { buildStreamSummary, type StreamSummaryInput } from "../functions/logic.js";
import { FEED_EMOJIS, getCatalogEntry } from "./catalog.js";

/** Generic tokens every feed has. Keep in sync with docs/feeds-bridge.md and the website. */
export const FEED_TOKENS = ["title", "url", "summary", "image", "source", "source_url", "source_icon", "published", "author", "tags", "roles"] as const;
/** YouTube aliases (older messages use them). */
export const YOUTUBE_TOKENS = [
  "video_title",
  "video_url",
  "video_thumbnail",
  "video_id",
  "published_at",
  "upload_type",
  "channel_name",
  "channel_handle",
  "channel_url",
  "channel_avatar",
] as const;
/** Twitch aliases. */
export const TWITCH_TOKENS = [
  "stream_title",
  "stream_url",
  "stream_thumbnail",
  "game_name",
  "viewer_count",
  "started_at",
  "streamer_name",
  "streamer_handle",
  "streamer_url",
  "streamer_avatar",
] as const;

/** Replace every `{token}` present in `tokens`. Unknown `{words}` are left alone. */
export function interpolateTokens(text: string, tokens: Record<string, string>): string {
  const keys = Object.keys(tokens);
  if (!keys.length || !text) return text;
  const re = new RegExp(`\\{(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\}`, "g");
  return text.replace(re, (_m, key: string) => tokens[key] ?? "");
}

export type RenderSource = Pick<FeedSourceRow, "type" | "title" | "iconUrl" | "siteUrl" | "config">;
export type RenderItem = Pick<FeedItemRow, "itemKey" | "title" | "url" | "imageUrl" | "summary" | "author" | "tags" | "publishedAt" | "firstSeenAt" | "payload">;

function relative(date: Date | null): string {
  return date && Number.isFinite(date.getTime()) ? `<t:${Math.floor(date.getTime() / 1000)}:R>` : "";
}

/** Every token for an item, including the YouTube and Twitch aliases. */
export function buildFeedTokens(source: RenderSource, item: RenderItem): Record<string, string> {
  const published = relative(item.publishedAt ?? item.firstSeenAt);
  const payload = item.payload ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const handle = str(source.config.handle);
  const login = str(source.config.login);
  const sourceUrl = source.siteUrl ?? "";
  const icon = source.iconUrl ?? "";
  const image = item.imageUrl ?? "";
  const tokens: Record<string, string> = {
    title: item.title,
    url: item.url,
    summary: item.summary,
    image,
    source: source.title,
    source_url: sourceUrl,
    source_icon: icon,
    published,
    author: item.author ?? "",
    tags: item.tags.slice(0, 8).join(", "),
  };
  if (source.type === "youtube") {
    Object.assign(tokens, {
      video_title: item.title,
      video_url: item.url,
      video_thumbnail: image,
      video_id: item.itemKey,
      published_at: published,
      upload_type: str(payload.typeLabel) || "video",
      channel_name: source.title,
      channel_handle: handle,
      channel_url: sourceUrl,
      channel_avatar: icon,
    });
  }
  if (source.type === "twitch") {
    const startedMs = typeof payload.startedAt === "number" ? payload.startedAt : null;
    Object.assign(tokens, {
      stream_title: item.title,
      stream_url: item.url,
      // Twitch caches preview images; a per-session query string makes Discord fetch a fresh one.
      stream_thumbnail: image ? `${image}${image.includes("?") ? "&" : "?"}s=${encodeURIComponent(item.itemKey)}` : "",
      game_name: str(payload.gameName),
      viewer_count: typeof payload.viewerCount === "number" ? payload.viewerCount.toLocaleString("en-US") : "0",
      started_at: startedMs ? relative(new Date(startedMs)) : published,
      streamer_name: source.title,
      streamer_handle: login ? `@${login}` : "",
      streamer_url: sourceUrl,
      streamer_avatar: icon,
    });
    tokens.image = tokens.stream_thumbnail!;
  }
  return tokens;
}

/** http(s) URLs only: Discord rejects the whole message for one bad button or image URL. */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1000) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The text above the card, with role pings substituted at `{roles}`, else prepended. */
export function buildContent(template: string, roleIds: string[], tokens: Record<string, string>): string {
  const roleMentions = roleIds.map((id) => `<@&${id}>`).join(" ");
  const rendered = interpolateTokens(template, tokens).trim();
  if (!roleMentions) return rendered.replace(/\{roles\}/g, "").trim().slice(0, 2000);
  if (rendered.includes("{roles}")) return rendered.replace(/\{roles\}/g, roleMentions).slice(0, 2000);
  return (rendered ? `${roleMentions} ${rendered}` : roleMentions).slice(0, 2000);
}

function resolveImageSource(kind: string, customUrl: string, tokens: Record<string, string>): string | null {
  if (kind === "channel") return safeUrl(tokens.source_icon);
  if (kind === "video") return safeUrl(tokens.image);
  if (kind === "url") return safeUrl(interpolateTokens(customUrl, tokens));
  return null;
}

function buttonsRow(message: FeedMessage, tokens: Record<string, string>): APIActionRowComponent<APIButtonComponent> | null {
  const buttons: APIButtonComponent[] = [];
  for (const button of message.buttons.slice(0, 5)) {
    const url = safeUrl(interpolateTokens(button.url, tokens));
    const label = interpolateTokens(button.label, tokens).replace(/\\(.)/g, "$1").trim().slice(0, 80);
    if (!url || !label) continue;
    buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, label, url });
  }
  return buttons.length ? { type: ComponentType.ActionRow, components: buttons } : null;
}

/** Components V2 text displays share a 4000 character budget per message. */
const V2_TEXT_BUDGET = 3900;

export type FeedSendOptions = {
  /** Roles to ping (the subscription's, or a YouTube type override's). */
  roleIds: string[];
  /** Quiet hours / cooldown: post with no pings and Discord's silent flag. */
  silent?: boolean;
  /** Replace the message's text (YouTube Short/live overrides). */
  contentOverride?: string;
};

export type FeedPayload = BaseMessageOptions & { flags?: number };

export function buildFeedPayload(message: FeedMessage, source: RenderSource, item: RenderItem, options: FeedSendOptions): FeedPayload {
  const tokens = buildFeedTokens(source, item);
  const content = buildContent(options.contentOverride ?? message.content, options.roleIds, tokens);
  const allowedMentions = { roles: options.silent ? [] : options.roleIds, parse: [] as [] };
  const silentFlag = options.silent ? MessageFlags.SuppressNotifications : 0;
  const row = buttonsRow(message, tokens);

  if (!message.embed.enabled) {
    // Text mode: never empty, so a design with no text still says what happened.
    const text = content || `**${item.title}**\n${item.url}`.trim();
    return {
      content: text.slice(0, 2000),
      components: row ? [row] : [],
      allowedMentions,
      ...(silentFlag ? { flags: silentFlag } : {}),
    };
  }

  const card = message.embed;
  const parts: string[] = [];
  const authorName = interpolateTokens(card.author_name, tokens).trim();
  if (authorName) {
    const authorUrl = safeUrl(interpolateTokens(card.author_url, tokens));
    parts.push(`-# ${emojiFor(source)} ${authorUrl ? `[${authorName}](${authorUrl})` : authorName}`.slice(0, 300));
  }
  const title = interpolateTokens(card.title, tokens).trim().slice(0, 256);
  if (title) {
    const titleUrl = safeUrl(interpolateTokens(card.title_url, tokens));
    parts.push(titleUrl ? `### [${title}](${titleUrl})` : `### ${title}`);
  }
  const fields = card.fields
    .slice(0, 25)
    .map((f) => ({ name: interpolateTokens(f.name, tokens).trim().slice(0, 256), value: interpolateTokens(f.value, tokens).trim().slice(0, 1024) }))
    .filter((f) => f.name && f.value)
    .map((f) => `**${f.name}**\n${f.value}`);
  const footerBits = [interpolateTokens(card.footer_text, tokens).trim()];
  if (card.timestamp) footerBits.push(relative(item.publishedAt ?? item.firstSeenAt));
  const footer = footerBits.filter(Boolean).join(" · ");

  const used = content.length + parts.join("\n").length + fields.join("\n\n").length + footer.length + 40;
  const description = interpolateTokens(card.description, tokens).trim().slice(0, Math.max(0, V2_TEXT_BUDGET - used));
  if (description) parts.push(description);
  if (fields.length) parts.push(fields.join("\n\n"));
  if (footer) parts.push(`-# ${footer}`);

  const body = parts.join("\n").trim() || item.title;
  const thumbnail = resolveImageSource(card.thumbnail, card.thumbnail_url, tokens);
  const image = resolveImageSource(card.image, card.image_url, tokens);

  const children: ComponentInContainerData[] = [];
  if (thumbnail) {
    children.push({
      type: ComponentType.Section,
      components: [{ type: ComponentType.TextDisplay, content: body }],
      accessory: { type: ComponentType.Thumbnail, media: { url: thumbnail } },
    });
  } else {
    children.push({ type: ComponentType.TextDisplay, content: body });
  }
  if (image) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: image } }] });
  if (row) {
    children.push({ type: ComponentType.Separator, divider: false, spacing: SeparatorSpacingSize.Small });
    children.push(row as unknown as ComponentInContainerData);
  }

  const components: TopLevelComponentData[] = [];
  if (content) components.push({ type: ComponentType.TextDisplay, content });
  components.push({ type: ComponentType.Container, components: children, accentColor: card.color });
  return {
    components,
    allowedMentions,
    flags: MessageFlags.IsComponentsV2 | silentFlag,
  };
}

/** The app emoji shown on a source's card. */
export function emojiFor(source: Pick<FeedSourceRow, "type" | "config">): string {
  const catalogKey = typeof source.config.catalogKey === "string" ? source.config.catalogKey : null;
  const entry = catalogKey ? getCatalogEntry(catalogKey) : null;
  if (entry) return entry.emoji;
  switch (source.type) {
    case "youtube":
      return FEED_EMOJIS.youtube;
    case "twitch":
      return FEED_EMOJIS.twitch;
    case "github":
      return FEED_EMOJIS.github;
    case "steam":
      return FEED_EMOJIS.steam;
    case "statuspage":
      return FEED_EMOJIS.status;
    case "newswire":
      return FEED_EMOJIS.news;
    default:
      return FEED_EMOJIS.rss;
  }
}

/** The stream-ended edit / summary, in the same style (card or text) as the live message. */
export function buildStreamEndedPayload(
  message: FeedMessage,
  source: RenderSource,
  input: StreamSummaryInput,
): FeedPayload {
  const summary = buildStreamSummary(input);
  const stats = summary.fields.map((f) => `**${f.name}:** ${f.value}`).join(" · ");
  const button: APIActionRowComponent<APIButtonComponent> = {
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: summary.button.label, url: summary.button.url }],
  };
  if (!message.embed.enabled) {
    return {
      content: `${FEED_EMOJIS.ended} **${source.title}** was live: ${summary.title}\n${stats}`.slice(0, 2000),
      components: [button],
      embeds: [],
      allowedMentions: { parse: [] },
    };
  }
  const body = [`-# ${FEED_EMOJIS.ended} Stream ended`, `### ${summary.heading}`, summary.title, stats].join("\n");
  const icon = safeUrl(source.iconUrl);
  const children: ComponentInContainerData[] = [
    icon
      ? {
          type: ComponentType.Section,
          components: [{ type: ComponentType.TextDisplay, content: body }],
          accessory: { type: ComponentType.Thumbnail, media: { url: icon } },
        }
      : { type: ComponentType.TextDisplay, content: body },
    button as unknown as ComponentInContainerData,
  ];
  return {
    components: [{ type: ComponentType.Container, components: children, accentColor: 0x6e6a86 }],
    allowedMentions: { parse: [] },
    flags: MessageFlags.IsComponentsV2,
  };
}
