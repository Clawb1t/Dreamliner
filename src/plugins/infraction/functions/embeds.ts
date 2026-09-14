import type { Client } from "discord.js";
import type { EmojisConfig } from "../../../config/schemas/guild.js";
import { baseEmbed, embedField, setEmbedAuthor, trimLines, type ResultContainer } from "../../../core/embeds.js";
import { discordTimestampBoth } from "../../../core/datetime.js";
import { formatDurationShort } from "./duration.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

function typeLabel(type: string, t: Translator): string {
  switch (type) {
    case "warn":
      return t("infraction.typeLabelWarn", "Warning");
    case "note":
      return t("infraction.typeLabelNote", "Note");
    case "mute":
      return t("infraction.typeLabelMute", "Mute");
    case "tempmute":
      return t("infraction.typeLabelTempMute", "Temp Mute");
    case "unmute":
      return t("infraction.typeLabelUnmute", "Unmute");
    case "kick":
      return t("infraction.typeLabelKick", "Kick");
    case "ban":
      return t("infraction.typeLabelBan", "Ban");
    case "tempban":
      return t("infraction.typeLabelTempBan", "Temp Ban");
    case "unban":
      return t("infraction.typeLabelUnban", "Unban");
    case "softban":
      return t("infraction.typeLabelSoftban", "Softban");
    case "clean":
      return t("infraction.typeLabelClean", "Clean");
    default:
      return type;
  }
}

export type InfractionRecord = {
  id: number;
  guildId: string;
  userId: string;
  modId: string;
  type: string;
  reason: string | null;
  active: boolean;
  expiresAt: Date | null;
  createdAt: Date;
};

export function buildInfractionEmbed(
  record: InfractionRecord,
  client: Client,
  options: {
    userTag?: string;
    modTag?: string;
    title?: string;
    emojis?: EmojisConfig;
    t?: Translator;
  } = {},
): ResultContainer {
  const label = typeLabel(record.type, options.t ?? defaultTranslator);
  const embed = baseEmbed();
  setEmbedAuthor(embed, options.title ?? `Infraction #${record.id}`, client, {
    tone: "neutral",
    emojis: options.emojis,
  });
  embed.addFields(
    embedField("Type", label, true),
    embedField("User", options.userTag ? `${options.userTag} (\`${record.userId}\`)` : `\`${record.userId}\``, true),
    embedField("Moderator", options.modTag ? `${options.modTag} (\`${record.modId}\`)` : `\`${record.modId}\``, true),
    embedField("Active", record.active ? "Yes" : "No", true),
    embedField("Created", discordTimestampBoth(record.createdAt), true),
  );
  if (record.expiresAt) {
    embed.addFields(embedField("Expires", discordTimestampBoth(record.expiresAt), true));
  }
  embed.addFields(embedField("Reason", record.reason?.trim() || "No reason provided."));
  return embed;
}

export function buildInfractionListEmbed(
  records: InfractionRecord[],
  title: string,
  client: Client,
  emojis?: EmojisConfig,
  t: Translator = defaultTranslator,
): ResultContainer {
  const embed = setEmbedAuthor(baseEmbed(), title, client, { tone: "neutral", emojis });
  if (records.length === 0) {
    embed.setDescription("No infractions found.");
    return embed;
  }

  const lines = records.map((r) => {
    const label = typeLabel(r.type, t);
    const active = r.active ? "" : " (inactive)";
    const expires = r.expiresAt ? ` (expires ${formatDurationShort(r.expiresAt.getTime() - Date.now())})` : "";
    return `#${r.id} **${label}**${active} <@${r.userId}> - ${r.reason?.slice(0, 60) ?? "No reason"}${expires}`;
  });

  embed.setDescription(trimLines(lines.join("\n")));
  return embed;
}

const ACTION_VERBS: Record<string, string> = {
  warn: "Warned",
  note: "Noted",
  mute: "Muted",
  tempmute: "Muted",
  unmute: "Unmuted",
  kick: "Kicked",
  ban: "Banned",
  tempban: "Banned",
  unban: "Unbanned",
  softban: "Softbanned",
  clean: "Cleaned",
};

/**
 * One-line action confirmation, e.g. `Muted @user for \`10m\` for "reason"` — the
 * command-response format; the fuller Type/User/Moderator/Reason breakdown
 * (buildInfractionEmbed) is reserved for /case view, which is an explicit detail lookup.
 */
export function buildActionConfirmLine(
  type: string,
  userId: string,
  reason: string,
  durationLabel?: string | null,
): string {
  const verb = ACTION_VERBS[type] ?? type;
  const parts = [`${verb} <@${userId}>`];
  if (durationLabel) parts.push(`for \`${durationLabel}\``);
  if (reason) parts.push(`for "${reason}"`);
  return parts.join(" ");
}
