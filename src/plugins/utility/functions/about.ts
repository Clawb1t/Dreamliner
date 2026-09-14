import { ActionRowBuilder, ButtonBuilder, type Client } from "discord.js";
import { getSiteUrl, linkButton } from "../../../core/docsUrl.js";
import { baseEmbed, pingQualityEmoji, trimLines, type ResultContainer } from "../../../core/embeds.js";
import { BUILD_TIME, BUILD_VERSION } from "../../../generated/version.js";
import type { Translator } from "../../../i18n/index.js";

const startTime = Date.now();
const SERVERS_EMOJI = "<:icons_serverinsight:1544417809109352489>";
const USERS_EMOJI = "<:icons_Person:1544417372260278353>";
const CHANNELS_EMOJI = "<:icons_channel:1544417183734431805>";
const VERSION_EMOJI = "<:icons_tags:1544418228049158174>";
const REBOOTED_EMOJI = "<:icons_update:1544417598559752364>";
const NODE_EMOJI = "<:icons_nodejs:1544418106221404201>";
const MEMORY_EMOJI = "<:icons_monitor:1544417346460975194>";
const BUILT_EMOJI = "<:icons_hammer:1544417299937763348>";

export function buildAboutEmbed(client: Client, t: Translator): ResultContainer {
  const guilds = client.guilds.cache.size;
  const users = client.users.cache.size;
  const channels = client.channels.cache.size;
  const ping = client.ws.ping;
  const uptimeAt = Math.floor(startTime / 1000);
  const builtAt = Math.floor(new Date(BUILD_TIME).getTime() / 1000);
  const memoryMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

  return baseEmbed()
    .setDescription(
      trimLines(`
        ${t("utility.about.description", "A Discord moderation and utility bot. Configure everything from the web dashboard, with granular permissions and plugins like stats, welcomer, tags, and automod.")}

        ${SERVERS_EMOJI} ${t("utility.about.servers", "Servers")}: \`${guilds.toLocaleString()}\`
        ${USERS_EMOJI} ${t("utility.about.users", "Users")}: \`${users.toLocaleString()}\` ${t("utility.about.cached", "cached")}
        ${CHANNELS_EMOJI} ${t("utility.about.channels", "Channels")}: \`${channels.toLocaleString()}\`
        ${pingQualityEmoji(ping)} ${t("utility.about.latency", "Latency")}: \`${ping}\`ms
        ${VERSION_EMOJI} ${t("utility.about.version", "Version")}: \`${BUILD_VERSION}\`
        ${REBOOTED_EMOJI} ${t("utility.about.lastRebooted", "Last rebooted")}: <t:${uptimeAt}:R>
        ${NODE_EMOJI} ${t("utility.about.node", "Node")}: \`${process.version}\`
        ${MEMORY_EMOJI} ${t("utility.about.memory", "Memory")}: \`${memoryMb}\` ${t("utility.about.mbHeap", "MB heap")}
        ${BUILT_EMOJI} ${t("utility.about.built", "Built")}: <t:${builtAt}:R>
      `),
    )
    .setFooter({ text: t("utility.about.footer", "Made with ❤️ by ClawB1t") });
}

export function aboutLinkRows(t: Translator): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton(t("utility.about.website", "Website"), getSiteUrl())),
  ];
}
