import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageCreateOptions,
  type User,
  type WebhookMessageCreateOptions,
} from "discord.js";
import type {
  PersistEmbedConfig,
  PersistSticky,
} from "../../../config/schemas/persist.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { renderTemplate, type TemplateContext } from "../../../core/templates.js";

export type PersistBuildContext = {
  client: Client;
  guild: Guild;
  channel: GuildTextBasedChannel;
  user?: User | null;
  member?: GuildMember | null;
};

function httpUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return trimmed;
  } catch {
    return undefined;
  }
  return undefined;
}

function templateCtx(ctx: PersistBuildContext): TemplateContext {
  return {
    guild: ctx.guild,
    channel: ctx.channel as TemplateContext["channel"],
    user: ctx.user ?? null,
    member: ctx.member ?? null,
  };
}

function resolveIconUrl(
  mode: "none" | "guild" | "bot" | "url",
  url: string,
  ctx: PersistBuildContext,
): string | undefined {
  if (mode === "none") return undefined;
  if (mode === "guild") return ctx.guild.iconURL({ size: 256, extension: "png" }) ?? undefined;
  if (mode === "bot") return ctx.client.user?.displayAvatarURL({ size: 256, extension: "png" });
  return httpUrl(url);
}

function buildEmbed(embed: PersistEmbedConfig, ctx: PersistBuildContext): EmbedBuilder | null {
  if (!embed.enabled) return null;

  const t = templateCtx(ctx);
  const builder = new EmbedBuilder();
  let used = false;

  const title = renderTemplate(embed.title, t).trim();
  const description = renderTemplate(embed.description, t).trim();
  if (title) {
    builder.setTitle(title);
    used = true;
  }
  if (description) {
    builder.setDescription(description);
    used = true;
  }

  const titleUrl = httpUrl(embed.title_url);
  if (titleUrl) {
    try {
      builder.setURL(titleUrl);
    } catch {
      // ignore invalid embed URLs
    }
  }

  if (embed.color != null) builder.setColor(embed.color);

  const authorName = renderTemplate(embed.author_name, t).trim();
  const authorIcon = resolveIconUrl(embed.author_icon, embed.author_icon_url, ctx);
  const authorUrl = httpUrl(embed.author_url);
  if (authorName) {
    builder.setAuthor({
      name: authorName,
      iconURL: authorIcon,
      url: authorUrl,
    });
    used = true;
  }

  const thumbnailUrl = resolveIconUrl(embed.thumbnail, embed.thumbnail_url, ctx);
  if (thumbnailUrl) {
    builder.setThumbnail(thumbnailUrl);
    used = true;
  }

  const imageUrl = httpUrl(embed.image_url);
  if (imageUrl) {
    builder.setImage(imageUrl);
    used = true;
  }

  const footerText = renderTemplate(embed.footer_text, t).trim();
  const footerIcon = resolveIconUrl(embed.footer_icon, embed.footer_icon_url, ctx);
  if (footerText || footerIcon) {
    builder.setFooter({
      text: footerText || "\u200b",
      iconURL: footerIcon,
    });
    used = true;
  }

  if (embed.timestamp) {
    builder.setTimestamp(new Date());
    used = true;
  }

  for (const field of embed.fields ?? []) {
    const name = renderTemplate(field.name, t).trim();
    const value = renderTemplate(field.value, t).trim();
    if (!name || !value) continue;
    builder.addFields({ name, value, inline: Boolean(field.inline) });
    used = true;
  }

  return used ? builder : null;
}

function buildButtons(sticky: PersistSticky): ActionRowBuilder<ButtonBuilder> | null {
  const buttons: ButtonBuilder[] = [];
  for (const item of sticky.buttons ?? []) {
    const url = httpUrl(item.url);
    const label = item.label.trim();
    if (!url || !label) continue;
    const button = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
    const emoji = parseComponentEmoji(item.emoji);
    if (emoji) button.setEmoji(emoji);
    buttons.push(button);
    if (buttons.length >= 5) break;
  }
  if (!buttons.length) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

function mentionParse(sticky: PersistSticky): Array<"users" | "roles" | "everyone"> {
  const parse: Array<"users" | "roles" | "everyone"> = [];
  if (sticky.mention_users) parse.push("users");
  if (sticky.mention_roles) parse.push("roles");
  if (sticky.mention_everyone) parse.push("everyone");
  return parse;
}

function messageFlags(sticky: PersistSticky): number | undefined {
  let flags = 0;
  if (sticky.silent) flags |= MessageFlags.SuppressNotifications;
  if (sticky.suppress_embeds) flags |= MessageFlags.SuppressEmbeds;
  return flags || undefined;
}

export type BuiltPersistMessage = {
  payload: MessageCreateOptions;
  webhookPayload: WebhookMessageCreateOptions;
  empty: boolean;
  webhookUsername: string;
  webhookAvatarURL?: string;
};

export function buildPersistPayload(sticky: PersistSticky, ctx: PersistBuildContext): BuiltPersistMessage {
  const t = templateCtx(ctx);
  const content = renderTemplate(sticky.content ?? "", t).trim();
  const embed = buildEmbed(sticky.embed, ctx);
  const row = buildButtons(sticky);
  const flags = messageFlags(sticky);
  const allowedMentions = { parse: mentionParse(sticky) };

  const empty = !content && !embed && !row;
  const payload: MessageCreateOptions = {
    ...(content ? { content } : {}),
    ...(embed ? { embeds: [embed] } : {}),
    ...(row ? { components: [row] } : {}),
    ...(flags != null ? { flags } : {}),
    allowedMentions,
  };

  const webhookUsername =
    sticky.webhook_name.trim() || sticky.name.trim() || "Sticky";
  const webhookAvatarURL = httpUrl(sticky.webhook_avatar_url);

  const webhookPayload: WebhookMessageCreateOptions = {
    ...payload,
    username: webhookUsername.slice(0, 80),
    ...(webhookAvatarURL ? { avatarURL: webhookAvatarURL } : {}),
  };

  return { payload, webhookPayload, empty, webhookUsername, webhookAvatarURL };
}

function embedSnapshot(embed: Message["embeds"][number] | EmbedBuilder) {
  const data = embed.toJSON();
  return {
    title: data.title ?? "",
    description: data.description ?? "",
    url: data.url ?? "",
    color: data.color ?? null,
    author: data.author
      ? { name: data.author.name ?? "", icon: data.author.icon_url ?? "", url: data.author.url ?? "" }
      : null,
    thumbnail: data.thumbnail?.url ?? "",
    image: data.image?.url ?? "",
    footer: data.footer ? { text: data.footer.text ?? "", icon: data.footer.icon_url ?? "" } : null,
    fields: (data.fields ?? []).map((field) => ({
      name: field.name,
      value: field.value,
      inline: Boolean(field.inline),
    })),
    timestamp: Boolean(data.timestamp),
  };
}

function buttonSnapshot(
  components: Message["components"] | MessageCreateOptions["components"],
): Array<{ label: string; url: string }> {
  const buttons: Array<{ label: string; url: string }> = [];
  for (const row of components ?? []) {
    const children = "components" in row && Array.isArray(row.components) ? row.components : [];
    for (const component of children) {
      const data =
        component && typeof component === "object" && "data" in component
          ? (component.data as { label?: string; url?: string })
          : (component as { label?: string; url?: string });
      buttons.push({
        label: typeof data.label === "string" ? data.label : "",
        url: typeof data.url === "string" ? data.url : "",
      });
    }
  }
  return buttons;
}

export function persistMessageFingerprint(
  message: Pick<Message, "content" | "embeds" | "components" | "author" | "webhookId">,
): string {
  return JSON.stringify({
    content: message.content ?? "",
    embeds: message.embeds.map((embed) => embedSnapshot(embed)),
    buttons: buttonSnapshot(message.components),
    webhookName: message.webhookId ? message.author.username : "",
  });
}

export function persistPayloadFingerprint(
  built: BuiltPersistMessage,
  useWebhook: boolean,
): string {
  const embed = built.payload.embeds?.[0];
  return JSON.stringify({
    content: built.payload.content ?? "",
    embeds: embed ? [embedSnapshot(embed as EmbedBuilder)] : [],
    buttons: buttonSnapshot(built.payload.components),
    webhookName: useWebhook ? built.webhookUsername : "",
  });
}

export function stickyHasContent(sticky: PersistSticky): boolean {
  if (sticky.content.trim()) return true;
  if ((sticky.buttons ?? []).some((button) => button.label.trim() && button.url.trim())) return true;
  const embed = sticky.embed;
  if (!embed.enabled) return false;
  return Boolean(
    embed.title.trim() ||
      embed.description.trim() ||
      embed.image_url.trim() ||
      embed.author_name.trim() ||
      embed.footer_text.trim() ||
      embed.fields.some((field) => field.name.trim() && field.value.trim()),
  );
}
