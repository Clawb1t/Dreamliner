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
  const t = options.t ?? defaultTranslator;
  embed.addFields(
    embedField(t("infraction.fieldType", "Type"), label, true),
    embedField(t("infraction.fieldUser", "User"), options.userTag ? `${options.userTag} (\`${record.userId}\`)` : `\`${record.userId}\``, true),
    embedField(t("infraction.fieldModerator", "Moderator"), options.modTag ? `${options.modTag} (\`${record.modId}\`)` : `\`${record.modId}\``, true),
    embedField(t("infraction.fieldActive", "Active"), record.active ? t("infraction.yes", "Yes") : t("infraction.no", "No"), true),
    embedField(t("infraction.fieldCreated", "Created"), discordTimestampBoth(record.createdAt), true),
  );
  if (record.expiresAt) {
    embed.addFields(embedField(t("infraction.fieldExpires", "Expires"), discordTimestampBoth(record.expiresAt), true));
  }
  embed.addFields(embedField(t("infraction.fieldReason", "Reason"), record.reason?.trim() || t("infraction.noReasonProvided", "No reason provided.")));
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
    embed.setDescription(t("infraction.noInfractionsFound", "No infractions found."));
    return embed;
  }

  const lines = records.map((r) => {
    const label = typeLabel(r.type, t);
    const active = r.active ? "" : ` (${t("infraction.inactive", "inactive")})`;
    const expires = r.expiresAt ? ` (${t("infraction.expiresParenthetical", "expires {duration}", { duration: formatDurationShort(r.expiresAt.getTime() - Date.now()) })})` : "";
    return `#${r.id} **${label}**${active} <@${r.userId}> - ${r.reason?.slice(0, 60) ?? t("infraction.noReason", "No reason")}${expires}`;
  });

  embed.setDescription(trimLines(lines.join("\n")));
  return embed;
}

function actionVerb(type: string, t: Translator): string {
  switch (type) {
    case "warn":
      return t("infraction.verbWarned", "Warned");
    case "note":
      return t("infraction.verbNoted", "Noted");
    case "mute":
    case "tempmute":
      return t("infraction.verbMuted", "Muted");
    case "unmute":
      return t("infraction.verbUnmuted", "Unmuted");
    case "kick":
      return t("infraction.verbKicked", "Kicked");
    case "ban":
    case "tempban":
      return t("infraction.verbBanned", "Banned");
    case "unban":
      return t("infraction.verbUnbanned", "Unbanned");
    case "softban":
      return t("infraction.verbSoftbanned", "Softbanned");
    case "clean":
      return t("infraction.verbCleaned", "Cleaned");
    default:
      return type;
  }
}

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
  t: Translator = defaultTranslator,
): string {
  const verb = actionVerb(type, t);
  const parts = [`${verb} <@${userId}>`];
  if (durationLabel) parts.push(t("infraction.confirmForDuration", 'for `{duration}`', { duration: durationLabel }));
  if (reason) parts.push(t("infraction.confirmForReason", 'for "{reason}"', { reason }));
  return parts.join(" ");
}
