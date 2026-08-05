import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type EmbedBuilder,
} from "discord.js";
import { docsPageUrl, resolveDocsUrl } from "../../../core/docsUrl.js";
import { baseEmbed, botAvatarURL, embedField, trimLines } from "../../../core/embeds.js";
import { BUILD_TIME, BUILD_VERSION } from "../../../generated/version.js";

const startTime = Date.now();

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
      "A Discord moderation bot with file-based YAML configuration and granular permissions.",
    )
    .addFields(
      embedField("Servers", `\`${guilds.toLocaleString()}\``, true),
      embedField("Users", `\`${users.toLocaleString()}\` cached`, true),
      embedField("Channels", `\`${channels.toLocaleString()}\``, true),
      embedField("Latency", `\`${ping}\`ms`, true),
      embedField("Version", `\`${BUILD_VERSION}\``, true),
      embedField("Last rebooted", `<t:${uptimeAt}:R>`, true),
      embedField(
        "Runtime",
        trimLines(`
          Node \`${process.version}\`
          Memory \`${memoryMb}\` MB heap
          Built \`${BUILD_VERSION}\` · <t:${builtAt}:R>
        `),
      ),
    )
    .setFooter({ text: "Made with ❤️ by ClawB1t" });
}

export function aboutLinkRows(docsUrl = resolveDocsUrl()): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel("Documentation").setStyle(ButtonStyle.Link).setURL(docsUrl),
      new ButtonBuilder()
        .setLabel("Terms of Service")
        .setStyle(ButtonStyle.Link)
        .setURL(docsPageUrl("terms-of-service", docsUrl)),
      new ButtonBuilder()
        .setLabel("Privacy Policy")
        .setStyle(ButtonStyle.Link)
        .setURL(docsPageUrl("privacy-policy", docsUrl)),
    ),
  ];
}
