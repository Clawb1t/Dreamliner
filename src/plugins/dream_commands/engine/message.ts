/**
 * Turns a MessageSpec into a Discord payload: variables interpolated (person-provided values
 * escaped), Discord's length limits enforced before sending, links kept only when they're
 * http(s), and pings limited to exactly what the step allows. allowedMentions never uses
 * "parse" for users or roles, so text can't widen who gets pinged.
 */
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import type { MessageSpec } from "./types.js";
import { interpolate, type VarStore } from "./vars.js";
import type { OutgoingMessage } from "./responder.js";

export type RenderInput = {
  vars: VarStore;
  rng: () => number;
  runnerId: string;
  optionUserIds: Iterable<string>;
  now?: Date;
};

const URL_RE = /^https?:\/\/[^\s<>"]{1,1000}$/i;

export function safeUrl(text: string): string | undefined {
  const trimmed = text.trim();
  if (!URL_RE.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function pickVariant(spec: MessageSpec, rng: () => number): string | null {
  const variants = spec.variants.map((v) => v.trim()).filter(Boolean);
  if (!variants.length) return null;
  return variants[Math.floor(rng() * variants.length)] ?? variants[0]!;
}

export function allowedMentionsFor(spec: MessageSpec, input: Pick<RenderInput, "runnerId" | "optionUserIds">): OutgoingMessage["allowedMentions"] {
  const users = new Set<string>();
  if (spec.pings.runner) users.add(input.runnerId);
  if (spec.pings.optionUsers) for (const id of input.optionUserIds) users.add(id);
  const allowed: OutgoingMessage["allowedMentions"] = { parse: spec.pings.everyone ? ["everyone"] : [] };
  if (users.size) allowed.users = [...users].slice(0, 100);
  if (spec.pings.roles.length) allowed.roles = spec.pings.roles.slice(0, 10);
  return allowed;
}

/** True when the spec has nothing to show. */
export function messageIsEmpty(spec: MessageSpec): boolean {
  if (spec.format === "text") return !spec.content.trim() && !spec.variants.some((v) => v.trim());
  if (spec.format === "embed") {
    const e = spec.embed;
    return !spec.content.trim() && !e.title.trim() && !e.description.trim() && !e.authorName.trim() && !e.imageUrl.trim() && !e.fields.length;
  }
  const c = spec.container;
  return !c.title.trim() && !c.body.trim() && !c.imageUrl.trim() && !spec.variants.some((v) => v.trim());
}

export function renderMessage(spec: MessageSpec, input: RenderInput, extraComponents: unknown[] = []): OutgoingMessage {
  const msg = (text: string, max: number) => cut(interpolate(text, input.vars, { mode: "message", rng: input.rng, now: input.now }), max);
  const raw = (text: string) => interpolate(text, input.vars, { mode: "raw", rng: input.rng, now: input.now });
  const allowedMentions = allowedMentionsFor(spec, input);
  const variant = pickVariant(spec, input.rng);

  if (spec.format === "container") {
    const c = spec.container;
    const inner: Record<string, unknown>[] = [];
    const title = c.title.trim() ? msg(c.title, 256) : "";
    const body = msg(variant ?? c.body, 3500);
    const thumb = c.thumbnailUrl.trim() ? safeUrl(raw(c.thumbnailUrl)) : undefined;
    const text = [title ? `## ${title}` : "", body].filter(Boolean).join("\n") || "​";
    if (thumb) {
      inner.push({
        type: ComponentType.Section,
        components: [{ type: ComponentType.TextDisplay, content: text }],
        accessory: { type: ComponentType.Thumbnail, media: { url: thumb } },
      });
    } else {
      inner.push({ type: ComponentType.TextDisplay, content: text });
    }
    const image = c.imageUrl.trim() ? safeUrl(raw(c.imageUrl)) : undefined;
    if (image) inner.push({ type: ComponentType.MediaGallery, items: [{ media: { url: image } }] });
    if (c.footer.trim()) {
      inner.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
      inner.push({ type: ComponentType.TextDisplay, content: `-# ${msg(c.footer, 400)}` });
    }
    for (const row of extraComponents) inner.push(row as Record<string, unknown>);
    const container: Record<string, unknown> = { type: ComponentType.Container, components: inner };
    if (c.accentColor !== null) container.accent_color = c.accentColor;
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions };
  }

  const out: OutgoingMessage = { allowedMentions };
  const content = msg(spec.format === "text" ? (variant ?? spec.content) : spec.content, 2000).trim();
  if (content) out.content = content;

  if (spec.format === "embed") {
    const e = spec.embed;
    const embed: Record<string, unknown> = {};
    let budget = 6000;
    const take = (text: string, max: number) => {
      const value = cut(text, Math.max(1, Math.min(max, budget)));
      budget -= value.length;
      return value;
    };
    if (e.title.trim()) embed.title = take(msg(e.title, 256), 256);
    const titleUrl = e.titleUrl.trim() ? safeUrl(raw(e.titleUrl)) : undefined;
    if (titleUrl && embed.title) embed.url = titleUrl;
    if (e.description.trim()) embed.description = take(msg(e.description, 4096), 4096);
    if (e.color !== null) embed.color = e.color;
    if (e.authorName.trim()) {
      const author: Record<string, string> = { name: take(msg(e.authorName, 256), 256) };
      const icon = e.authorIconUrl.trim() ? safeUrl(raw(e.authorIconUrl)) : undefined;
      const url = e.authorUrl.trim() ? safeUrl(raw(e.authorUrl)) : undefined;
      if (icon) author.icon_url = icon;
      if (url) author.url = url;
      embed.author = author;
    }
    const thumb = e.thumbnailUrl.trim() ? safeUrl(raw(e.thumbnailUrl)) : undefined;
    if (thumb) embed.thumbnail = { url: thumb };
    const image = e.imageUrl.trim() ? safeUrl(raw(e.imageUrl)) : undefined;
    if (image) embed.image = { url: image };
    const fields = e.fields
      .filter((f) => f.name.trim() || f.value.trim())
      .slice(0, 25)
      .map((f) => ({ name: take(msg(f.name, 256) || "​", 256), value: take(msg(f.value, 1024) || "​", 1024), inline: f.inline }));
    if (fields.length) embed.fields = fields;
    if (e.footerText.trim()) embed.footer = { text: take(msg(e.footerText, 2048), 2048) };
    if (e.timestamp) embed.timestamp = (input.now ?? new Date()).toISOString();
    if (Object.keys(embed).length) out.embeds = [embed];
  }

  if (!out.content && !out.embeds?.length) out.content = "​";
  if (extraComponents.length) out.components = extraComponents;
  return out;
}

export const BUTTON_STYLES: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
