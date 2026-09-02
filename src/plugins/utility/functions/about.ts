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
const SERVERS_EMOJI = "<:icons_serverinsight:1544417809109352489>";
const USERS_EMOJI = "<:icons_Person:1544417372260278353>";
const CHANNELS_EMOJI = "<:icons_channel:1544417183734431805>";
const VERSION_EMOJI = "<:icons_tags:1544418228049158174>";
const REBOOTED_EMOJI = "<:icons_update:1544417598559752364>";
const NODE_EMOJI = "<:icons_nodejs:1544418106221404201>";
const MEMORY_EMOJI = "<:icons_monitor:1544417346460975194>";
const BUILT_EMOJI = "<:icons_hammer:1544417299937763348>";

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

        ${SERVERS_EMOJI} Servers: \`${guilds.toLocaleString()}\`
        ${USERS_EMOJI} Users: \`${users.toLocaleString()}\` cached
        ${CHANNELS_EMOJI} Channels: \`${channels.toLocaleString()}\`
        ${pingQualityEmoji(ping)} Latency: \`${ping}\`ms
        ${VERSION_EMOJI} Version: \`${BUILD_VERSION}\`
        ${REBOOTED_EMOJI} Last rebooted: <t:${uptimeAt}:R>
        ${NODE_EMOJI} Node: \`${process.version}\`
        ${MEMORY_EMOJI} Memory: \`${memoryMb}\` MB heap
        ${BUILT_EMOJI} Built: <t:${builtAt}:R>
      `),
    )
    .setFooter({ text: "Made with ❤️ by ClawB1t" });
}

export function aboutLinkRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton("Website", getSiteUrl())),
  ];
}
