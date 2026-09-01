import {
  ActionRowBuilder,
  ButtonBuilder,
  type Client,
  type EmbedBuilder,
} from "discord.js";
import { getSiteUrl, linkButton } from "../../../core/docsUrl.js";
import { baseEmbed, botAvatarURL, pingQualityEmoji, trimLines } from "../../../core/embeds.js";
import { BUILD_TIME, BUILD_VERSION } from "../../../generated/version.js";

const startTime = Date.now();
const BULLET = "<:icons_square:1544418208549970101>";

export function buildAboutEmbed(client: Client): EmbedBuilder {
  const guilds = client.guilds.cache.size;
  const users = client.users.cache.size;
  const channels = client.channels.cache.size;
  const ping = client.ws.ping;
  const uptimeAt = Math.floor(startTime / 1000);
  const builtAt = Math.floor(new Date(BUILD_TIME).getTime() / 1000);
  const memoryMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

  return baseEmbed()
    .setAuthor({ name: "Dreamliner", iconURL: botAvatarURL(client) })
    .setTitle("About Dreamliner")
    .setDescription(
      trimLines(`
        A Discord moderation and utility bot. Configure everything from the web dashboard, with granular permissions and plugins like stats, welcomer, tags, and automod.

        ${BULLET} Servers: \`${guilds.toLocaleString()}\`
        ${BULLET} Users: \`${users.toLocaleString()}\` cached
        ${BULLET} Channels: \`${channels.toLocaleString()}\`
        ${pingQualityEmoji(ping)} Latency: \`${ping}\`ms
        ${BULLET} Version: \`${BUILD_VERSION}\`
        ${BULLET} Last rebooted: <t:${uptimeAt}:R>
        ${BULLET} Node: \`${process.version}\`
        ${BULLET} Memory: \`${memoryMb}\` MB heap
        ${BULLET} Built: <t:${builtAt}:R>
      `),
    )
    .setFooter({ text: "Made with ❤️ by ClawB1t" });
}

export function aboutLinkRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton("Website", getSiteUrl())),
  ];
}
