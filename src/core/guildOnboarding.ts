import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
} from "discord.js";
import {
  SUPPORT_URL,
  docsPageUrl,
  getGlobalLeaderboardUrl,
  getGlobalStatsUrl,
  getGuildDashboardUrl,
  getGuildStatsDashboardUrl,
  getInviteUrl,
} from "./docsUrl.js";
import { publicLeaderboardUrl } from "./publicLeaderboard.js";

function canSendInChannel(guild: Guild, channel: GuildTextBasedChannel): boolean {
  if (!("send" in channel) || channel.isDMBased()) return false;
  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    return false;
  }
  const me = guild.members.me;
  if (!me) return true;
  const perms = channel.permissionsFor(me);
  return Boolean(
    perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
  );
}

/** Prefer the system channel, otherwise the first text channel the bot can speak in. */
export async function findFirstSpeakableChannel(
  guild: Guild,
): Promise<GuildTextBasedChannel | null> {
  await guild.channels.fetch().catch(() => null);

  const system = guild.systemChannel;
  if (system && canSendInChannel(guild, system)) return system;

  const candidates = [...guild.channels.cache.values()]
    .filter(
      (ch): ch is GuildTextBasedChannel =>
        ch.isTextBased() && !ch.isDMBased() && canSendInChannel(guild, ch as GuildTextBasedChannel),
    )
    .sort((a, b) => {
      const aPos = "position" in a ? a.position : 0;
      const bPos = "position" in b ? b.position : 0;
      return aPos - bPos;
    });

  return candidates[0] ?? null;
}

async function commandMention(
  client: Client,
  name: string,
  subcommand?: string,
): Promise<string> {
  try {
    const commands = await client.application?.commands.fetch();
    const cmd = commands?.find((entry) => entry.name === name);
    if (!cmd) {
      return subcommand ? `\`/${name} ${subcommand}\`` : `\`/${name}\``;
    }
    return subcommand ? `</${name} ${subcommand}:${cmd.id}>` : `</${name}:${cmd.id}>`;
  } catch {
    return subcommand ? `\`/${name} ${subcommand}\`` : `\`/${name}\``;
  }
}

function linkButton(label: string, url: string) {
  return {
    type: ComponentType.Button as const,
    style: ButtonStyle.Link as const,
    label: label.slice(0, 80),
    url,
  };
}

/** Components V2 onboarding message for newly added guilds. */
export async function buildGuildOnboardingPayload(
  client: Client,
  guild: Guild,
): Promise<MessageCreateOptions> {
  const guildId = guild.id;
  const dashboardUrl = getGuildDashboardUrl(guildId);
  const statsDashUrl = getGuildStatsDashboardUrl(guildId);
  const publicLb = publicLeaderboardUrl(guildId);

  const [statsServer, configEditor, about] = await Promise.all([
    commandMention(client, "stats", "server"),
    commandMention(client, "config", "editor"),
    commandMention(client, "about"),
  ]);

  const heading = "# Welcome to Dreamliner";
  const intro = [
    `Thanks for adding **Dreamliner** to **${guild.name}**.`,
    "",
    "Dreamliner is a moderation and utility bot configured from a web dashboard. Channels, roles, welcomer, tags, stats, automod, and more are all set up there.",
  ].join("\n");

  const dashboardSection = [
    "## Dashboard first",
    "Open the **server dashboard** (button below), sign in with Discord, pick this server, then configure plugins and save. Changes apply immediately.",
    "",
    `Prefer Discord? Start with ${configEditor}, or ${about} for website and docs.`,
  ].join("\n");

  const statsSection = [
    "## Stats and leaderboards",
    `Use ${statsServer} for interactive charts in Discord, or open **Server stats** below.`,
    publicLb
      ? "Share this server's public messager leaderboard with the button below."
      : "Browse global stats and the global leaderboard with the buttons below.",
  ].join("\n");

  const helpSection = [
    "## Help",
    `Need more? Use **Docs** and **Support** below, or invite Dreamliner again: ${getInviteUrl()}`,
  ].join("\n");

  const row1 = [
    linkButton("Open dashboard", dashboardUrl),
    linkButton("Server stats", statsDashUrl),
    linkButton("Docs", docsPageUrl("getting-started")),
  ];
  const row2 = [
    linkButton("Global stats", getGlobalStatsUrl()),
    linkButton("Global leaderboard", getGlobalLeaderboardUrl()),
    linkButton("Support", SUPPORT_URL),
  ];
  if (publicLb) {
    row2.unshift(linkButton("Public leaderboard", publicLb));
    // Keep max 5 buttons per row.
    while (row2.length > 5) row2.pop();
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          { type: ComponentType.TextDisplay, content: heading },
          { type: ComponentType.TextDisplay, content: intro },
          { type: ComponentType.Separator, divider: true, spacing: 1 },
          { type: ComponentType.TextDisplay, content: dashboardSection },
          { type: ComponentType.TextDisplay, content: statsSection },
          { type: ComponentType.TextDisplay, content: helpSection },
          { type: ComponentType.ActionRow, components: row1 },
          { type: ComponentType.ActionRow, components: row2 },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  } as MessageCreateOptions;
}

export async function sendGuildOnboardingMessage(client: Client, guild: Guild): Promise<void> {
  const channel = await findFirstSpeakableChannel(guild);
  if (!channel) return;
  const payload = await buildGuildOnboardingPayload(client, guild);
  await channel.send(payload).catch((error) => {
    console.warn(
      `[onboarding] failed to send welcome in guild ${guild.id}:`,
      error instanceof Error ? error.message : error,
    );
  });
}
