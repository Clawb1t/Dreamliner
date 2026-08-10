import {
  AttachmentBuilder,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type User,
} from "discord.js";
import type {
  WelcomeCardConfig,
  WelcomeDmConfig,
  WelcomeEmbedConfig,
  WelcomeEventConfig,
  WelcomeMessageConfig,
  WelcomeWaveButton,
} from "../../../config/schemas/welcome.js";
import { buildTemplateVars, renderTemplate } from "../../../core/templates.js";
import { renderWelcomeCard, WELCOME_CARD_FILENAME } from "./cardRenderer.js";
import { buildWaveButtonRow } from "./waveButton.js";

export type WelcomeTarget = "join" | "leave" | "dm";

export type WelcomeBuildContext = {
  guildId: string;
  member?: GuildMember | null;
  user?: User | null;
  guild?: Guild | null;
};

function resolveIconUrl(
  mode: "none" | "avatar" | "guild" | "url",
  url: string,
  vars: Record<string, string>,
): string | undefined {
  if (mode === "none") return undefined;
  if (mode === "avatar") return vars.avatar_url || undefined;
  if (mode === "guild") return vars.guild_icon_url || undefined;
  const trimmed = url.trim();
  return trimmed || undefined;
}

function buildEmbed(embed: WelcomeEmbedConfig, ctx: WelcomeBuildContext): EmbedBuilder | null {
  if (!embed.enabled) return null;

  const templateCtx = {
    member: ctx.member ?? null,
    user: ctx.user ?? ctx.member?.user ?? null,
    guild: ctx.guild ?? ctx.member?.guild ?? null,
  };
  const vars = buildTemplateVars(templateCtx);
  const builder = new EmbedBuilder();

  const title = renderTemplate(embed.title, templateCtx).trim();
  const description = renderTemplate(embed.description, templateCtx).trim();
  if (title) builder.setTitle(title);
  if (description) builder.setDescription(description);
  if (embed.color != null) builder.setColor(embed.color);

  const authorName = renderTemplate(embed.author_name, templateCtx).trim();
  const authorIcon = resolveIconUrl(embed.author_icon, embed.author_icon_url, vars);
  if (authorName) {
    builder.setAuthor({ name: authorName, iconURL: authorIcon });
  }

  const thumb = resolveIconUrl(embed.thumbnail, embed.thumbnail_url, vars);
  if (thumb) builder.setThumbnail(thumb);

  if (embed.image === "url") {
    const imageUrl = embed.image_url.trim();
    if (imageUrl) builder.setImage(imageUrl);
  }

  const footerText = renderTemplate(embed.footer_text, templateCtx).trim();
  const footerIcon = resolveIconUrl(embed.footer_icon, embed.footer_icon_url, vars);
  if (footerText || footerIcon) {
    builder.setFooter({
      text: footerText || "\u200b",
      iconURL: footerIcon,
    });
  }

  if (embed.timestamp) builder.setTimestamp(new Date());

  for (const field of embed.fields ?? []) {
    const name = renderTemplate(field.name, templateCtx).trim();
    const value = renderTemplate(field.value, templateCtx).trim();
    if (!name || !value) continue;
    builder.addFields({ name, value, inline: Boolean(field.inline) });
  }

  return builder;
}

async function maybeRenderCard(
  card: WelcomeCardConfig,
  ctx: WelcomeBuildContext,
): Promise<Buffer | null> {
  if (!card.enabled) return null;
  return renderWelcomeCard(card, ctx);
}

export type BuiltWelcomeMessage = {
  payload: MessageCreateOptions;
  channelId?: string;
  empty: boolean;
};

export async function buildWelcomePayload(
  event: WelcomeEventConfig | WelcomeDmConfig,
  ctx: WelcomeBuildContext,
  options?: { channelId?: string; waveButton?: WelcomeWaveButton | null },
): Promise<BuiltWelcomeMessage> {
  const templateCtx = {
    member: ctx.member ?? null,
    user: ctx.user ?? ctx.member?.user ?? null,
    guild: ctx.guild ?? ctx.member?.guild ?? null,
  };

  const content = renderTemplate(event.content ?? "", templateCtx).trim();
  const cardBuffer = await maybeRenderCard(event.card, ctx);
  const embed = buildEmbed(event.embed, ctx);
  const wave = options?.waveButton?.enabled ? options.waveButton : null;

  const files: AttachmentBuilder[] = [];
  if (cardBuffer) {
    files.push(new AttachmentBuilder(cardBuffer, { name: WELCOME_CARD_FILENAME }));
  }

  const empty = !content && !embed && files.length === 0 && !wave;
  const payload: MessageCreateOptions = {
    ...(content ? { content } : {}),
    ...(embed ? { embeds: [embed] } : {}),
    ...(files.length ? { files } : {}),
    ...(wave ? { components: [buildWaveButtonRow(wave, 0)] } : {}),
  };

  return {
    payload,
    channelId: options?.channelId ?? ("channel_id" in event ? event.channel_id : undefined),
    empty,
  };
}

export function getWelcomeEventConfig(
  config: WelcomeMessageConfig,
  target: WelcomeTarget,
): WelcomeEventConfig | WelcomeDmConfig {
  if (target === "leave") return config.leave;
  if (target === "dm") return config.dm;
  return config.join;
}

export function previewEmbedJson(
  embed: WelcomeEmbedConfig,
  ctx: WelcomeBuildContext,
): Record<string, unknown> | null {
  if (!embed.enabled) return null;
  const templateCtx = {
    member: ctx.member ?? null,
    user: ctx.user ?? ctx.member?.user ?? null,
    guild: ctx.guild ?? ctx.member?.guild ?? null,
  };
  const vars = buildTemplateVars(templateCtx);
  const fields = (embed.fields ?? [])
    .map((field) => ({
      name: renderTemplate(field.name, templateCtx).trim(),
      value: renderTemplate(field.value, templateCtx).trim(),
      inline: Boolean(field.inline),
    }))
    .filter((field) => field.name && field.value);

  return {
    title: renderTemplate(embed.title, templateCtx).trim() || null,
    description: renderTemplate(embed.description, templateCtx).trim() || null,
    color: embed.color ?? null,
    author:
      embed.author_name.trim()
        ? {
            name: renderTemplate(embed.author_name, templateCtx).trim(),
            iconURL: resolveIconUrl(embed.author_icon, embed.author_icon_url, vars) ?? null,
          }
        : null,
    thumbnail: resolveIconUrl(embed.thumbnail, embed.thumbnail_url, vars) ?? null,
    image: embed.image === "url" ? embed.image_url.trim() || null : null,
    footer: embed.footer_text.trim()
      ? {
          text: renderTemplate(embed.footer_text, templateCtx).trim(),
          iconURL: resolveIconUrl(embed.footer_icon, embed.footer_icon_url, vars) ?? null,
        }
      : null,
    timestamp: embed.timestamp ? new Date().toISOString() : null,
    fields,
  };
}
