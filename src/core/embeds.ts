import { ComponentType, SeparatorSpacingSize, type Client, type GuildMember } from "discord.js";
import type { ComponentInContainerData, ContainerComponentData, TextDisplayComponentData } from "discord.js";
import type { EmojisConfig, GuildConfig } from "../config/schemas/guild.js";
import { resolveEmojiForContent } from "./emoji.js";

const DEFAULT_EMOJIS: EmojisConfig = {
  success: "<:icons_Correct:1544417199798886530>",
  error: "<:icons_Wrong:1544417460638457937>",
  neutral: "<:icons_generalinfo:1544417795335389254>",
  warning: "<:icons_exclamation:1544417272376852490>",
  unchecked: "<:icons_disable:1544417870652379277>",
};

export type EmbedTone = "success" | "neutral" | "error" | "warning" | "unchecked";

export type ResultEmbedOptions = {
  imageURL?: string | null;
  client?: Client;
  tone?: EmbedTone;
  emoji?: string;
  emojis?: EmojisConfig;
};

export type EmbedHeaderOptions = {
  thumbnailURL?: string | null;
  tone?: EmbedTone;
  emoji?: string;
  emojis?: EmojisConfig;
};

export function botAvatarURL(client: Client): string {
  return client.user!.displayAvatarURL({ size: 128 });
}

function resolveEmojis(emojis?: EmojisConfig): EmojisConfig {
  return emojis ?? DEFAULT_EMOJIS;
}

function resolveToneEmoji(tone: EmbedTone, emojis: EmojisConfig, client?: Client): string {
  let raw: string;
  if (tone === "success") raw = emojis.success;
  else if (tone === "error") raw = emojis.error;
  else if (tone === "warning") raw = emojis.warning;
  else if (tone === "unchecked") raw = emojis.unchecked;
  else raw = emojis.neutral;
  return resolveEmojiForContent(raw, client);
}

export function inferEmbedTone(title: string): EmbedTone {
  const lower = title.toLowerCase();
  if (
    /permission denied|error|invalid|failed|not found|missing|cannot|can't|no `|must be used|could not|denied|required/.test(
      lower,
    )
  ) {
    return "error";
  }
  if (/\bdisabled\b|cleared|unchecked|turned off|deactivated/.test(lower)) {
    return "unchecked";
  }
  if (/not configured|already |exists|warning|expired|using defaults|no longer configured/.test(lower)) {
    return "warning";
  }
  if (
    /updated|saved|reload|success|complete|deleted|applied|valid|sent|upload|download|template|reloaded|reset|moved|disconnected|clean/.test(
      lower,
    )
  ) {
    return "success";
  }
  return "neutral";
}

export function trimLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function trimEmptyLines(text: string): string {
  return trimLines(
    text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .join("\n"),
  );
}

export function discordTs(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

export function yesNo(value: boolean, emojis?: EmojisConfig, client?: Client): string {
  const resolved = resolveEmojis(emojis);
  const yes = resolveEmojiForContent(resolved.success, client);
  const no = resolveEmojiForContent(resolved.unchecked, client);
  return value ? `${yes} Yes` : `${no} No`;
}

/** Build a markdown code fence without accidental template-literal indentation */
export function codeBlock(content: string, lang = ""): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

export type ContainerField = { name: string; value: string; inline?: boolean };

export function embedField(name: string, value: string, inline = false): ContainerField {
  return { name, value: trimLines(value), inline };
}

/** Dreamliner brand accent — no longer applied to command-response containers (see ResultContainer), kept for the handful of dashboard-authored embeds that still use a real Discord embed. */
export const DREAMLINER_ACCENT = 0x5865f2;
export const DREAMLINER_ACCENT_HEX = "#5865F2";

/**
 * Small, subtle, colorless Components V2 container — the bot's standard shape for command
 * responses, mirroring `core/logging/container.ts`: a bold title line, optional thumbnail,
 * optional description/fields, no accent color and no author block.
 */
export class ResultContainer {
  private titleText = "";
  private descriptionText?: string;
  private fieldList: ContainerField[] = [];
  private thumbnailURL?: string | null;
  private imageURLs: string[] = [];
  private footerText?: string;

  setTitle(title: string): this {
    this.titleText = title;
    return this;
  }

  setDescription(text: string | null | undefined): this {
    this.descriptionText = text ?? undefined;
    return this;
  }

  addFields(...fields: (ContainerField | ContainerField[])[]): this {
    for (const entry of fields) {
      if (Array.isArray(entry)) this.fieldList.push(...entry);
      else this.fieldList.push(entry);
    }
    return this;
  }

  setThumbnail(url: string | null | undefined): this {
    this.thumbnailURL = url;
    return this;
  }

  setImage(url: string | null | undefined): this {
    this.imageURLs = url ? [url] : [];
    return this;
  }

  /** Multiple large images shown side by side (e.g. an avatar next to a banner). */
  setImages(urls: (string | null | undefined)[]): this {
    this.imageURLs = urls.filter((url): url is string => Boolean(url));
    return this;
  }

  setFooter(footer: { text: string; iconURL?: string } | null | undefined): this {
    this.footerText = footer?.text;
    return this;
  }

  private fieldsText(): string | undefined {
    if (!this.fieldList.length) return undefined;
    return this.fieldList.map((f) => `**${f.name}**\n${f.value}`).join("\n\n");
  }

  /**
   * Build the single `Container` component this builder represents. `actionRows` (already
   * `.toJSON()`'d) are appended as the container's own final children — buttons/selects live
   * inside the container they act on, not as separate top-level rows below it.
   */
  toContainerComponent(actionRows?: ComponentInContainerData[]): ContainerComponentData {
    const children: ComponentInContainerData[] = [];
    const title = this.titleText ? `**${this.titleText}**` : "";

    if (this.thumbnailURL) {
      const headerParts: TextDisplayComponentData[] = [];
      if (title) headerParts.push({ type: ComponentType.TextDisplay, content: title });
      if (this.descriptionText) headerParts.push({ type: ComponentType.TextDisplay, content: this.descriptionText });
      if (!headerParts.length) headerParts.push({ type: ComponentType.TextDisplay, content: "​" });
      children.push({
        type: ComponentType.Section,
        components: headerParts,
        accessory: { type: ComponentType.Thumbnail, media: { url: this.thumbnailURL } },
      });
    } else {
      if (title) children.push({ type: ComponentType.TextDisplay, content: title });
      if (this.descriptionText) children.push({ type: ComponentType.TextDisplay, content: this.descriptionText });
    }

    const fieldsText = this.fieldsText();
    if (fieldsText) {
      children.push({ type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small });
      children.push({ type: ComponentType.TextDisplay, content: fieldsText });
    }

    if (this.imageURLs.length) {
      children.push({
        type: ComponentType.MediaGallery,
        items: this.imageURLs.map((url) => ({ media: { url } })),
      });
    }

    if (this.footerText) {
      children.push({ type: ComponentType.Separator, divider: false, spacing: SeparatorSpacingSize.Small });
      children.push({ type: ComponentType.TextDisplay, content: `-# ${this.footerText}` });
    }

    if (actionRows?.length) {
      children.push(...actionRows);
    }

    return { type: ComponentType.Container, components: children };
  }
}

/** Fresh, empty result container — the Components V2 replacement for the old `baseEmbed()`. */
export function baseEmbed(): ResultContainer {
  return new ResultContainer();
}

/** Sets the container's title line (with tone emoji) and optional thumbnail. No author block — Components V2 containers don't have one. */
export function setEmbedAuthor(
  container: ResultContainer,
  title: string,
  client: Client | undefined,
  subjectOrOptions?: string | null | EmbedHeaderOptions,
): ResultContainer {
  let thumbnailURL: string | null | undefined;
  let tone: EmbedTone | undefined;
  let emoji: string | undefined;
  let emojis = DEFAULT_EMOJIS;

  if (typeof subjectOrOptions === "string" || subjectOrOptions === null) {
    thumbnailURL = subjectOrOptions ?? undefined;
  } else if (subjectOrOptions) {
    thumbnailURL = subjectOrOptions.thumbnailURL;
    tone = subjectOrOptions.tone;
    emoji = subjectOrOptions.emoji;
    emojis = resolveEmojis(subjectOrOptions.emojis);
  }

  const resolvedTone = tone ?? inferEmbedTone(title);
  const prefix = resolveEmojiForContent(emoji ?? resolveToneEmoji(resolvedTone, emojis, client), client);

  container.setTitle(`${prefix} ${title}`);
  if (thumbnailURL) container.setThumbnail(thumbnailURL);
  return container;
}

/**
 * Dreamliner-style action, error, and status containers — the bot's generic command
 * acknowledgement. Deliberately minimal: an emoji and a line of text, no bold heading and no
 * "Information" label. `title` is a short category (e.g. "Not found") that's usually redundant
 * once `details` is read, so it's only shown when there's no `details` to fall back on.
 */
export function buildResultEmbed(
  title: string,
  details?: string,
  options?: ResultEmbedOptions,
): ResultContainer {
  const container = baseEmbed();
  const emojis = resolveEmojis(options?.emojis);
  const tone = options?.tone ?? inferEmbedTone(title);
  const prefix = resolveEmojiForContent(
    options?.emoji ?? resolveToneEmoji(tone, emojis, options?.client),
    options?.client,
  );
  const message = details?.trim() || title;
  container.setDescription(`${prefix} ${message}`);
  if (options?.imageURL) {
    container.setImage(options.imageURL);
  }
  return container;
}

/** <150ms good, <400ms medium, otherwise bad — used anywhere a live ping/latency number is shown. */
export function pingQualityEmoji(ms: number): string {
  if (ms < 150) return "<:icons_goodping:1544417298402644029>";
  if (ms < 400) return "<:icons_mediumping:1544417338554589244>";
  return "<:icons_badping:1544417484717686884>";
}

export function buildPingEmbed(roundtrip: number, ws: number, _client: Client, _emojis?: EmojisConfig): ResultContainer {
  return baseEmbed()
    .setDescription(`${pingQualityEmoji(ws)} **${ws}ms** · roundtrip **${roundtrip}ms**`);
}

export function memberAccentColor(member: GuildMember | null): number | undefined {
  if (!member) return undefined;
  const role = member.roles.cache
    .filter((r) => r.id !== member.guild.id && r.color !== 0)
    .sort((a, b) => b.position - a.position)
    .first();
  return role?.color ?? undefined;
}

export const CHANNEL_ICONS = {
  text: "https://cdn.discordapp.com/attachments/740650744830623756/740656843545772062/text-channel.png",
  voice: "https://cdn.discordapp.com/attachments/740650744830623756/740656845982662716/voice-channel.png",
  announcement: "https://cdn.discordapp.com/attachments/740650744830623756/740656841687564348/announcement-channel.png",
  stage: "https://cdn.discordapp.com/attachments/740650744830623756/839930647711186995/stage-channel.png",
  forum: "https://cdn.discordapp.com/attachments/740650744830623756/1091681253364875294/forum-channel-icon.png",
  thread: "https://cdn.discordapp.com/attachments/740650744830623756/870343055855738921/public-thread.png",
  snowflake: "https://cdn.discordapp.com/attachments/740650744830623756/742020790471491668/snowflake.png",
  message: "https://cdn.discordapp.com/attachments/740650744830623756/740685652152025088/message.png",
  mention: "https://cdn.discordapp.com/attachments/705009450855039042/839284872152481792/mention.png",
} as const;

export function guildResultOptions(
  client: Client,
  guildConfig: GuildConfig,
  extra?: Partial<ResultEmbedOptions>,
): ResultEmbedOptions {
  return { client, emojis: guildConfig.emojis, ...extra };
}

/** Container header options for slash command replies (uses guild emoji config). */
export function commandHeader(
  guildConfig: GuildConfig,
  opts?: Omit<EmbedHeaderOptions, "emojis">,
): EmbedHeaderOptions {
  return { tone: "neutral", ...opts, emojis: guildConfig.emojis };
}
