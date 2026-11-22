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

/** Where the welcome message's main button goes: the dashboard, opening the first-run setup. */
export function guildSetupUrl(guildId: string): string {
  return `${getGuildDashboardUrl(guildId)}?onboarding=1`;
}

/** Components V2 welcome message for newly added guilds, pointing at the dashboard's setup flow. */
export async function buildGuildOnboardingPayload(guild: Guild): Promise<MessageCreateOptions> {
  const heading = `## <:dreamlinerlogo:1536010087468892161> Dreamliner \u00d7 ${guild.name}`;
  const description = [
    `Everything your server needs. Connected.\nSet up Dreamliner for **${guild.name}** in about two minutes.`,
    "-# Only people with Manage Server can open the dashboard. This is the only message Dreamliner sends here on its own.",
  ].join("\n\n");

  const buttons = [
    linkButton("Get started", guildSetupUrl(guild.id)),
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

/**
 * Posts the welcome message once per server, ever: claimWelcomeMessage records it before
 * sending, so a rejoin, a retried GuildCreate or a second shard never posts it again.
 */
export async function sendGuildOnboardingMessage(guild: Guild): Promise<void> {
  const { claimWelcomeMessage } = await import("../bridge/webOnboarding.js");
  if (!claimWelcomeMessage(guild.id)) return;
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
