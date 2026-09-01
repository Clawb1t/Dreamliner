import { EmbedBuilder, type Client, type GuildMember } from "discord.js";
import type { EmojisConfig, GuildConfig } from "../config/schemas/guild.js";
import { resolveEmojiForContent } from "./emoji.js";

/** Zero-width space for embed field name padding */
export const EMPTY_EMBED = "\u200b";
export const PRE_EMBED_PADDING = `${EMPTY_EMBED}\n`;

const DEFAULT_EMOJIS: EmojisConfig = {
  success: "<:icons_Correct:1544417199798886530>",
  error: "<:icons_Wrong:1544417460638457937>",
  neutral: "<:icons_generalinfo:1544417795335389254>",
  warning: "<:icons_exclamation:1544417272376852490>",
  unchecked: "<:icons_disable:1544417870652379277>",
};

export type EmbedTone = "success" | "neutral" | "error" | "warning" | "unchecked";

export type ResultEmbedOptions = {
  color?: number;
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

export function setEmbedAuthor(
  embed: EmbedBuilder,
  title: string,
  client: Client,
  subjectOrOptions?: string | null | EmbedHeaderOptions,
): EmbedBuilder {
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

  embed.setAuthor({ name: "Dreamliner", iconURL: botAvatarURL(client) });
  embed.setTitle(`${prefix} ${title}`);
  if (thumbnailURL) embed.setThumbnail(thumbnailURL);
  return embed;
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

export function embedField(name: string, value: string, inline = false) {
  return { name: PRE_EMBED_PADDING + name, value: trimLines(value), inline };
}

/** Dreamliner brand accent used for embeds, charts, and leaderboard UI. */
export const DREAMLINER_ACCENT = 0x5865f2;
export const DREAMLINER_ACCENT_HEX = "#5865F2";

export function baseEmbed(): EmbedBuilder {
  return new EmbedBuilder().setColor(DREAMLINER_ACCENT);
}

/** Dreamliner-style action, error, and status embeds */
export function buildResultEmbed(
  title: string,
  details?: string,
  options?: ResultEmbedOptions,
): EmbedBuilder {
  const embed = baseEmbed();
  if (options?.color) embed.setColor(options.color);
  if (options?.client) {
    setEmbedAuthor(embed, title, options.client, {
      tone: options.tone ?? inferEmbedTone(title),
      emoji: options.emoji,
      emojis: options.emojis,
    });
  } else {
    const emojis = resolveEmojis(options?.emojis);
    const tone = options?.tone ?? inferEmbedTone(title);
    const prefix = resolveEmojiForContent(
      options?.emoji ?? resolveToneEmoji(tone, emojis, options?.client),
      options?.client,
    );
    embed.setTitle(`${prefix} ${title}`);
  }
  if (details) {
    embed.addFields(embedField("Information", details));
  }
  if (options?.imageURL) {
    embed.setImage(options.imageURL);
  }
  return embed;
}

/** <150ms good, <400ms medium, otherwise bad — used anywhere a live ping/latency number is shown. */
export function pingQualityEmoji(ms: number): string {
  if (ms < 150) return "<:icons_goodping:1544417298402644029>";
  if (ms < 400) return "<:icons_mediumping:1544417338554589244>";
  return "<:icons_badping:1544417484717686884>";
}

export function buildPingEmbed(roundtrip: number, ws: number, client: Client, emojis?: EmojisConfig): EmbedBuilder {
  return setEmbedAuthor(baseEmbed(), "Pong!", client, { tone: "success", emojis })
    .setDescription(`${pingQualityEmoji(ws)} **${ws}ms**`)
    .setFooter({ text: `Roundtrip is ${roundtrip}ms` });
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

/** Embed header options for slash command replies (uses guild emoji config). */
export function commandHeader(
  guildConfig: GuildConfig,
  opts?: Omit<EmbedHeaderOptions, "emojis">,
): EmbedHeaderOptions {
  return { tone: "neutral", ...opts, emojis: guildConfig.emojis };
}
