import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type Client,
  type Message,
  type MessageCreateOptions,
  type User,
  type WebhookMessageCreateOptions,
} from "discord.js";
import { baseEmbed, commandHeader, setEmbedAuthor } from "../../../core/embeds.js";
import { getLanguage } from "../../../core/languages.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";

const DREAMLINER_SITE = "https://dreamliner.site";
const TRANSLATE_FOOTER = `-# <:dreamlinerlogo:1536010087468892161> Translated with [Dreamliner](<${DREAMLINER_SITE}>)`;
const AUTO_TRANSLATE_MAX = 1900;

function buildAutoTranslateContent(translated: string): string {
  const body = translated.trim().slice(0, AUTO_TRANSLATE_MAX);
  return `${body}\n${TRANSLATE_FOOTER}`;
}

function clipLabel(text: string, max = 80): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function buildTranslationComponents(options: {
  from: string;
  to: string;
  author?: User | null;
  sourceMessage?: Message | null;
}): ActionRowBuilder<ButtonBuilder>[] {
  const fromLang = getLanguage(options.from);
  const toLang = getLanguage(options.to);
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId("dl:tr:langs")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
      .setLabel(clipLabel(`${fromLang.flag} ${fromLang.name} → ${toLang.flag} ${toLang.name}`)),
  );

  if (options.author) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("dl:tr:author")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
        .setLabel(clipLabel(options.author.username)),
    );
  }

  if (options.sourceMessage?.url) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Original")
        .setStyle(ButtonStyle.Link)
        .setURL(options.sourceMessage.url),
    );
  }

  return [row];
}

export function buildTranslationEmbed(
  client: Client,
  guildConfig: GuildConfig,
  options: {
    translated: string;
    from: string;
    to: string;
  },
) {
  return setEmbedAuthor(baseEmbed(), "Translation", client, {
    ...commandHeader(guildConfig),
    tone: "neutral",
  }).setDescription(options.translated.slice(0, 4096));
}

export function buildTranslationPayload(
  client: Client,
  guildConfig: GuildConfig,
  options: {
    translated: string;
    from: string;
    to: string;
    author?: User | null;
    sourceMessage?: Message | null;
  },
) {
  return {
    embeds: [
      buildTranslationEmbed(client, guildConfig, {
        translated: options.translated,
        from: options.from,
        to: options.to,
      }),
    ],
    components: buildTranslationComponents(options),
  };
}

/** Fallback bot reply when webhooks are unavailable. */
export function buildAutoTranslatePayload(options: {
  translated: string;
}): MessageCreateOptions {
  return {
    content: buildAutoTranslateContent(options.translated),
    flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Webhook payload: Discord author avatar/name + silent plain text. */
export function buildAutoTranslateWebhookPayload(options: {
  translated: string;
  author: User;
}): WebhookMessageCreateOptions {
  const name = (options.author.displayName || options.author.username).slice(0, 80);
  return {
    username: name,
    avatarURL: options.author.displayAvatarURL({ size: 256, extension: "png" }),
    content: buildAutoTranslateContent(options.translated),
    flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [] },
  };
}
