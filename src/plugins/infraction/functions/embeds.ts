import { EmbedBuilder, type Client } from "discord.js";
import type { EmojisConfig } from "../../../config/schemas/guild.js";
import type { InfractionType } from "../../../config/schemas/infraction.js";
import { baseEmbed, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { discordTimestampBoth } from "../../../core/datetime.js";
import { formatDurationShort } from "./duration.js";

const TYPE_COLORS: Record<string, number> = {
  warn: 0xffb347,
  note: 0x95a5a6,
  mute: 0xf39c12,
  tempmute: 0xf39c12,
  unmute: 0x2ecc71,
  kick: 0xe67e22,
  ban: 0xe74c3c,
  tempban: 0xe74c3c,
  unban: 0x2ecc71,
  softban: 0xc0392b,
  clean: 0x3498db,
};

const TYPE_LABELS: Record<string, string> = {
  warn: "Warning",
  note: "Note",
  mute: "Mute",
  tempmute: "Temp Mute",
  unmute: "Unmute",
  kick: "Kick",
  ban: "Ban",
  tempban: "Temp Ban",
  unban: "Unban",
  softban: "Softban",
  clean: "Clean",
};

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
  } = {},
): EmbedBuilder {
  const label = TYPE_LABELS[record.type] ?? record.type;
  const embed = baseEmbed().setColor(TYPE_COLORS[record.type as InfractionType] ?? 0x5865f2);
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
): EmbedBuilder {
  const embed = setEmbedAuthor(baseEmbed(), title, client, { tone: "neutral", emojis });
  if (records.length === 0) {
    embed.setDescription("No infractions found.");
    return embed;
  }

  const lines = records.map((r) => {
    const label = TYPE_LABELS[r.type] ?? r.type;
    const active = r.active ? "" : " (inactive)";
    const expires = r.expiresAt ? ` (expires ${formatDurationShort(r.expiresAt.getTime() - Date.now())})` : "";
    return `#${r.id} **${label}**${active} <@${r.userId}> - ${r.reason?.slice(0, 60) ?? "No reason"}${expires}`;
  });

  embed.setDescription(trimLines(lines.join("\n")));
  return embed;
}

export function buildActionConfirmDetails(
  type: string,
  userTag: string,
  userId: string,
  reason: string,
  extras?: string,
): string {
  return trimLines(`
    Type: **${TYPE_LABELS[type] ?? type}**
    User: **${userTag}** (\`${userId}\`)
    Reason: ${reason}
    ${extras ?? ""}
  `);
}
