import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
} from "discord.js";
import { SUPPORT_URL, getGuildDashboardUrl } from "./docsUrl.js";
import { getLogger } from "./logger.js";
const log = getLogger("core");

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

function linkButton(label: string, url: string) {
  return {
    type: ComponentType.Button as const,
    style: ButtonStyle.Link as const,
    label: label.slice(0, 80),
    url,
  };
}

/** Components V2 onboarding message for newly added guilds. */
export async function buildGuildOnboardingPayload(guild: Guild): Promise<MessageCreateOptions> {
  const guildId = guild.id;
  const dashboardUrl = getGuildDashboardUrl(guildId);

  const heading = "✈️ Welcome to Dreamliner";
  const description = [
    "Dreamliner is a moderation and utility bot with a web dashboard for easy configuration.",
    "Configure roles, channels, automod, tags, stats, and more from your server dashboard.",
  ].join(" ");

  const buttons = [
    linkButton("Dashboard", dashboardUrl),
    linkButton("Support", SUPPORT_URL),
  ];

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          { type: ComponentType.TextDisplay, content: heading },
          { type: ComponentType.TextDisplay, content: description },
          { type: ComponentType.ActionRow, components: buttons },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  } as MessageCreateOptions;
}

export async function sendGuildOnboardingMessage(guild: Guild): Promise<void> {
  const channel = await findFirstSpeakableChannel(guild);
  if (!channel) return;
  const payload = await buildGuildOnboardingPayload(guild);
  await channel.send(payload).catch((error) => {
    log.warn(
      `[onboarding] failed to send welcome in guild ${guild.id}:`,
      error instanceof Error ? error.message : error,
    );
  });
}
