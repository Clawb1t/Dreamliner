import {
  ApplicationIntegrationType,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type InteractionReplyOptions,
} from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { DREAMLINER_ACCENT } from "../../../core/embeds.js";
import { APP_EMOJI } from "../../../core/appEmojis.js";
import { getWrappedUrl } from "../../../core/docsUrl.js";
import { wrappedWindow, type WrappedWindow } from "../../../core/wrapped/window.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function longDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The /wrapped reply: one calm line and, from the countdown on, a link to the website, where Wrapped
 * lives. Ephemeral.
 */
export function buildWrappedReply(window: WrappedWindow): InteractionReplyOptions {
  const lastDay = longDate(new Date(Date.parse(window.closesAt) - 1).toISOString());
  const content =
    window.phase === "open"
      ? `${APP_EMOJI.tada} **Dreamliner Wrapped ${window.year}** is ready. Your year on Dreamliner, from the servers you spent it in to the emoji you leaned on. Sign in on the website to see it. Open until ${lastDay}.`
      : window.phase === "countdown"
        ? `${APP_EMOJI.hourglass} **Dreamliner Wrapped ${window.year}** opens on ${longDate(window.opensAt)}. Your year is being wrapped as we speak, and the countdown is on the website.`
        : `${APP_EMOJI.hourglass} **Dreamliner Wrapped ${window.year}** returns in December. Your year is still being written until then.`;
  const label = window.phase === "open" ? `Open Wrapped ${window.year}` : "See the countdown";
  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
    components: [
      {
        type: ComponentType.Container,
        accent_color: DREAMLINER_ACCENT,
        components: [
          { type: ComponentType.TextDisplay, content },
          ...(window.phase === "closed"
            ? []
            : [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label, url: getWrappedUrl() }] }]),
        ],
      },
    ],
  } as InteractionReplyOptions;
}

export const wrappedCommands: SlashCommandDefinition[] = [
  {
    // Personal and read-only (it only links to the website), so no permission flag. Also works as a
    // user app in DMs.
    plugin: "stats",
    userInstallable: true,
    data: new SlashCommandBuilder()
      .setName("wrapped")
      .setDescription("Your Dreamliner Wrapped, the yearly recap on the website")
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),
    execute: async (ctx) => {
      await ctx.interaction.reply(buildWrappedReply(wrappedWindow()));
    },
  },
];
