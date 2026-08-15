import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type User,
} from "discord.js";
import type { WelcomeEmbedConfig } from "../../../config/schemas/welcome.js";
import type { PassportConfig, PassportPanelConfig, PassportPingConfig } from "../../../config/schemas/passport.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { getPassportUrl, linkButton } from "../../../core/docsUrl.js";
import { buildTemplateVars, renderTemplate } from "../../../core/templates.js";

export type PassportBuildContext = {
  member?: GuildMember | null;
  user?: User | null;
  guild: Guild;
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

export function buildPassportEmbed(
  embed: WelcomeEmbedConfig,
  ctx: PassportBuildContext,
): EmbedBuilder | null {
  if (!embed.enabled) return null;

  const templateCtx = {
    member: ctx.member ?? null,
    user: ctx.user ?? ctx.member?.user ?? null,
    guild: ctx.guild,
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
  if (authorName) builder.setAuthor({ name: authorName, iconURL: authorIcon });

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

function verifyButton(label: string, emoji: string, guildId: string): ButtonBuilder {
  const button = linkButton(label.trim() || "Verify", getPassportUrl(guildId));
  const parsed = parseComponentEmoji(emoji);
  if (parsed) button.setEmoji(parsed);
  return button;
}

export function renderPassportText(template: string, ctx: PassportBuildContext): string {
  return renderTemplate(template, {
    member: ctx.member ?? null,
    user: ctx.user ?? ctx.member?.user ?? null,
    guild: ctx.guild,
  }).trim();
}

export function buildPassportPingPayload(
  ping: PassportPingConfig,
  ctx: PassportBuildContext,
): MessageCreateOptions {
  const content = renderPassportText(ping.content, ctx);
  const mention = ping.ping_style === "mention" && ctx.member ? `<@${ctx.member.id}>` : "";
  const body = [mention && !content.includes(`<@${ctx.member?.id ?? ""}>`) ? mention : "", content]
    .filter(Boolean)
    .join("\n")
    .trim();

  const embed = buildPassportEmbed(ping.embed, ctx);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    verifyButton(ping.button_label, ping.button_emoji, ctx.guild.id),
  );

  return {
    content: body || undefined,
    embeds: embed ? [embed] : [],
    components: [row],
    allowedMentions: ping.ping_style === "mention" && ctx.member ? { users: [ctx.member.id] } : { parse: [] },
  };
}

export function buildPassportPanelPayload(
  panel: PassportPanelConfig,
  ctx: PassportBuildContext,
): MessageCreateOptions {
  const content = renderPassportText(panel.content, ctx);
  const embed = buildPassportEmbed(panel.embed, ctx);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    verifyButton(panel.button_label, panel.button_emoji, ctx.guild.id),
  );
  return {
    content: content || undefined,
    embeds: embed ? [embed] : [],
    components: [row],
    allowedMentions: { parse: [] },
  };
}

export function buildPassportDmPayload(
  config: PassportConfig,
  ctx: PassportBuildContext,
): MessageCreateOptions {
  const ping = config.ping;
  const content =
    renderPassportText(ping.content, ctx) ||
    `Hey, welcome to **${ctx.guild.name}**.\n\nTap **Verify** to unlock the rest of the server.`;
  const embed = buildPassportEmbed(ping.embed, ctx);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    verifyButton(ping.button_label, ping.button_emoji, ctx.guild.id),
  );
  return {
    content,
    embeds: embed ? [embed] : [],
    components: [row],
  };
}

export function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}
