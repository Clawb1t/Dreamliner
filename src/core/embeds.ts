import { EmbedBuilder, type Client, type GuildMember } from "discord.js";
import type { EmojisConfig, GuildConfig } from "../config/schemas/guild.js";

/** Zero-width space for embed field name padding */
export const EMPTY_EMBED = "\u200b";
export const PRE_EMBED_PADDING = `${EMPTY_EMBED}\n`;

const DEFAULT_EMOJIS: EmojisConfig = {
  success: "<:checked:1524379445379465276>",
  error: "<:redcheck:1524379423757959208>",
  neutral: "<:greycheck:1524379394372669553>",
  warning: "<:lowwarning:1524379341000151170>",
  unchecked: "<:unchecked:1524379366996312104>",
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

function resolveToneEmoji(tone: EmbedTone, emojis: EmojisConfig): string {
  if (tone === "success") return emojis.success;
  if (tone === "error") return emojis.error;
  if (tone === "warning") return emojis.warning;
  if (tone === "unchecked") return emojis.unchecked;
  return emojis.neutral;
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
  const prefix = emoji ?? resolveToneEmoji(resolvedTone, emojis);

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

export function yesNo(value: boolean, emojis?: EmojisConfig): string {
  const resolved = resolveEmojis(emojis);
  return value ? `${resolved.success} Yes` : `${resolved.unchecked} No`;
}

/** Build a markdown code fence without accidental template-literal indentation */
export function codeBlock(content: string, lang = ""): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

export function embedField(name: string, value: string, inline = false) {
  return { name: PRE_EMBED_PADDING + name, value: trimLines(value), inline };
}

export function baseEmbed(): EmbedBuilder {
  return new EmbedBuilder().setColor(0x5865f2);
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
    const prefix = options?.emoji ?? resolveToneEmoji(tone, emojis);
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

export function buildPingEmbed(roundtrip: number, ws: number, client: Client, emojis?: EmojisConfig): EmbedBuilder {
  return setEmbedAuthor(baseEmbed(), "Ping", client, { tone: "neutral", emojis }).addFields(
    embedField(
      "Latency",
      trimLines(`
        Roundtrip: **${roundtrip}ms**
        WebSocket: **${ws}ms**
      `),
      true,
    ),
  );
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
