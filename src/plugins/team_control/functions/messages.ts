import type { ActionRowBuilder, Client, Guild, MessageActionRowComponentBuilder, User } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { baseEmbed, setEmbedAuthor, type ContainerField, type EmbedTone, type ResultContainer } from "../../../core/embeds.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { containerReply, pingComponent } from "../../../core/responses.js";

const log = getLogger("team_control");

const SNOWFLAKE = /^\d{17,20}$/;

/** The plugin's standard card: tone emoji + title, body, optional fields, thumbnail and footer. */
export function teamCard(
  client: Client,
  guildConfig: GuildConfig,
  title: string,
  body: string | null,
  options: { tone?: EmbedTone; fields?: ContainerField[]; thumbnail?: string | null; footer?: string | null; color?: number | null } = {},
): ResultContainer {
  const card = setEmbedAuthor(baseEmbed(), title, client, {
    tone: options.tone ?? "neutral",
    emojis: guildConfig.emojis,
    thumbnailURL: options.thumbnail ?? null,
  });
  if (body) card.setDescription(body);
  if (options.fields?.length) card.addFields(options.fields);
  if (options.footer) card.setFooter({ text: options.footer });
  if (options.color) card.setColor(options.color);
  return card;
}

/**
 * Posts a card in a guild channel (only channels in that guild). `pingRoleIds` actually pings
 * those roles; everything else in the card never pings. Returns the message, or null.
 */
export async function postTeamMessage(
  client: Client,
  guild: Guild,
  channelId: string | null,
  card: ResultContainer,
  options: { pingRoleIds?: string[]; rows?: ActionRowBuilder<MessageActionRowComponentBuilder>[] } = {},
) {
  const channel = await fetchGuildTextChannel(client, guild.id, channelId);
  if (!channel) return null;
  const payload = containerReply(card, false, options.rows);
  const roles = (options.pingRoleIds ?? []).filter((id) => SNOWFLAKE.test(id)).slice(0, 10);
  const send = roles.length
    ? { ...payload, components: [pingComponent(roles.map((id) => `<@&${id}>`).join(" ")), ...payload.components], allowedMentions: { roles } }
    : payload;
  return channel.send(send as Parameters<typeof channel.send>[0]).catch((error) => {
    log.warn(`Could not post in ${guild.id}/${channelId}: ${error instanceof Error ? error.message : error}`);
    return null;
  });
}

/** DMs a card. Members with DMs closed are skipped quietly. */
export async function dmTeamCard(
  user: User | null | undefined,
  card: ResultContainer,
  rows?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): Promise<boolean> {
  if (!user || user.bot) return false;
  const payload = containerReply(card, false, rows);
  const sent = await user.send(payload as Parameters<typeof user.send>[0]).catch(() => null);
  return Boolean(sent);
}
