import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInContainer,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIMessageComponentEmoji,
  type APIMessageTopLevelComponent,
  type APISectionAccessoryComponent,
  type APITextDisplayComponent,
} from "discord.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { MK_PREFIX } from "./constants.js";
import {
  assetIdOf,
  formatIssuePath,
  isHttpUrl,
  type KitBlock,
  type KitButton,
  type KitDocument,
  type KitEmbed,
  type KitLeafBlock,
  type KitRow,
  type KitSelect,
} from "./document.js";

/**
 * KitDocument → the raw Discord message body (classic or Components V2). Pure: placeholder values
 * and attachment file names come in through `RenderContext`, so the same function renders sends,
 * edits, DMs, ephemeral "reply with a kit" responses and tests.
 */

export type RenderContext = {
  /** Used in component custom ids (`mk:<kitId>:<componentId>`). */
  kitId: number;
  /** Placeholder values for markdown text (content, descriptions, fields, text blocks). */
  vars: Record<string, string>;
  /** Placeholder values where markdown doesn't render (titles, author, footer, labels, links). Defaults to `vars`. */
  plainVars?: Record<string, string>;
  /** The attachment file name for an uploaded asset, or null when the asset no longer exists. */
  assetFile: (assetId: string) => string | null;
  now?: Date;
};

export type KitMessageBody = {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIMessageTopLevelComponent[];
  flags: number;
  allowedMentions: { parse: ("users" | "roles" | "everyone")[] };
};

export type RenderedKit = {
  format: "classic" | "v2";
  body: KitMessageBody;
  /** Assets to attach as files, in order. Each is referenced by `attachment://<assetFile(id)>`. */
  assetIds: string[];
};

/** A document that's valid on its own but can't be sent as it stands (an asset was deleted, a
 *  placeholder made something too long, ...). `path` points at the part to fix. */
export class KitRenderError extends Error {
  constructor(
    message: string,
    readonly path = "",
  ) {
    super(message);
  }
}

// ── Text ────────────────────────────────────────────────────────────────────

/** `{key}` → value; unknown placeholders stay exactly as written. */
export function renderText(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(vars, key) ? vars[key]! : match));
}

/** `{date}` / `{time}` for markdown text (Discord timestamps, shown in each reader's own time zone)
 *  and for plain text (UTC). */
export function timeVars(now: Date): { markdown: Record<string, string>; plain: Record<string, string> } {
  const unix = Math.floor(now.getTime() / 1000);
  const plainDate = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(now);
  const plainTime = `${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now)} UTC`;
  return {
    markdown: { date: `<t:${unix}:D>`, time: `<t:${unix}:t>` },
    plain: { date: plainDate, time: plainTime },
  };
}

type Path = (string | number)[];

function tooLong(what: string, length: number, max: number, path: Path): KitRenderError {
  return new KitRenderError(`With placeholders filled in, ${what} is ${length} characters (the limit is ${max}).`, formatIssuePath(path));
}

class Renderer {
  readonly assetIds: string[] = [];
  private readonly plain: Record<string, string>;

  constructor(private readonly ctx: RenderContext) {
    this.plain = ctx.plainVars ?? ctx.vars;
  }

  md(text: string, max: number, what: string, path: Path): string {
    const out = renderText(text, this.ctx.vars).trim();
    if (out.length > max) throw tooLong(what, out.length, max, path);
    return out;
  }

  plainText(text: string, max: number, what: string, path: Path): string {
    const out = renderText(text, this.plain).trim();
    if (out.length > max) throw tooLong(what, out.length, max, path);
    return out;
  }

  attach(assetId: string, path: Path): string {
    const name = this.ctx.assetFile(assetId);
    if (!name) throw new KitRenderError("A file or image this kit uses was deleted from the asset library. Pick another one.", formatIssuePath(path));
    if (!this.assetIds.includes(assetId)) this.assetIds.push(assetId);
    return `attachment://${name}`;
  }

  /** An image reference → a URL Discord accepts, or undefined for "none". */
  image(raw: string, path: Path): string | undefined {
    const value = raw.trim();
    if (!value) return undefined;
    const assetId = assetIdOf(value);
    if (assetId) return this.attach(assetId, path);
    const rendered = renderText(value, this.plain).trim();
    return isHttpUrl(rendered) ? rendered : undefined;
  }

  requiredImage(raw: string, path: Path): string {
    const url = this.image(raw, path);
    if (!url) throw new KitRenderError("This image doesn't resolve to a link.", formatIssuePath(path));
    return url;
  }

  link(raw: string): string | undefined {
    const rendered = renderText(raw.trim(), this.plain).trim();
    return rendered && isHttpUrl(rendered) ? rendered : undefined;
  }

  // ── Embeds ──

  embed(embed: KitEmbed, path: Path): APIEmbed {
    const out: APIEmbed = {};
    const title = this.plainText(embed.title, 256, "the embed title", [...path, "title"]);
    if (title) out.title = title;
    const url = this.link(embed.url);
    if (url && title) out.url = url;
    const description = this.md(embed.description, 4096, "the embed description", [...path, "description"]);
    if (description) out.description = description;
    if (embed.color !== null) out.color = embed.color;
    const authorName = this.plainText(embed.author.name, 256, "the author name", [...path, "author", "name"]);
    if (authorName) {
      out.author = { name: authorName };
      const authorUrl = this.link(embed.author.url);
      if (authorUrl) out.author.url = authorUrl;
      const icon = this.image(embed.author.icon_url, [...path, "author", "icon_url"]);
      if (icon) out.author.icon_url = icon;
    }
    const thumbnail = this.image(embed.thumbnail_url, [...path, "thumbnail_url"]);
    if (thumbnail) out.thumbnail = { url: thumbnail };
    const image = this.image(embed.image_url, [...path, "image_url"]);
    if (image) out.image = { url: image };
    const footerText = this.plainText(embed.footer.text, 2048, "the footer", [...path, "footer", "text"]);
    if (footerText) {
      out.footer = { text: footerText };
      const icon = this.image(embed.footer.icon_url, [...path, "footer", "icon_url"]);
      if (icon) out.footer.icon_url = icon;
    }
    if (embed.timestamp === "now") out.timestamp = (this.ctx.now ?? new Date()).toISOString();
    else if (embed.timestamp !== "none") out.timestamp = new Date(embed.timestamp).toISOString();
    if (embed.fields.length) {
      out.fields = embed.fields.map((field, i) => ({
        name: this.md(field.name, 256, "a field name", [...path, "fields", i, "name"]) || "​",
        value: this.md(field.value, 1024, "a field value", [...path, "fields", i, "value"]) || "​",
        inline: field.inline,
      }));
    }
    return out;
  }

  // ── Components ──

  customId(componentId: string): string {
    return `${MK_PREFIX}${this.ctx.kitId}:${componentId}`;
  }

  button(button: KitButton, path: Path): APIButtonComponent {
    const label = this.plainText(button.label, 80, "a button label", [...path, "label"]);
    const emoji = toApiEmoji(button.emoji);
    const base = { type: ComponentType.Button as const, disabled: button.disabled, ...(label ? { label } : {}), ...(emoji ? { emoji } : {}) };
    if (button.style === "link") {
      const url = renderText(button.url.trim(), this.plain).trim();
      if (!/^(https?|discord):\/\//i.test(url)) throw new KitRenderError("This link button's link isn't valid.", formatIssuePath([...path, "url"]));
      return { ...base, style: ButtonStyle.Link, url };
    }
    return { ...base, style: BUTTON_STYLE[button.style], custom_id: this.customId(button.id) };
  }

  select(select: KitSelect, path: Path): APIComponentInMessageActionRow {
    const placeholder = this.plainText(select.placeholder, 150, "the menu placeholder", [...path, "placeholder"]);
    return {
      type: ComponentType.StringSelect,
      custom_id: this.customId(select.id),
      min_values: Math.min(select.min_values, select.options.length),
      max_values: Math.min(select.max_values, select.options.length),
      disabled: select.disabled,
      ...(placeholder ? { placeholder } : {}),
      options: select.options.map((option, i) => {
        const description = this.plainText(option.description, 100, "an option description", [...path, "options", i, "description"]);
        const emoji = toApiEmoji(option.emoji);
        return {
          label: this.plainText(option.label, 100, "an option label", [...path, "options", i, "label"]) || option.id,
          value: option.id,
          ...(description ? { description } : {}),
          ...(emoji ? { emoji } : {}),
        };
      }),
    };
  }

  row(row: KitRow, path: Path): APIActionRowComponent<APIComponentInMessageActionRow> {
    return {
      type: ComponentType.ActionRow,
      components:
        row.type === "buttons"
          ? row.buttons.map((button, i) => this.button(button, [...path, "buttons", i]))
          : [this.select(row.select, [...path, "select"])],
    };
  }

  // ── Components V2 ──

  textDisplay(text: string, path: Path): APITextDisplayComponent {
    const content = this.md(text, 4000, "this text", path);
    return { type: ComponentType.TextDisplay, content: content || "​" };
  }

  leaf(block: KitLeafBlock, path: Path): APIComponentInContainer {
    switch (block.type) {
      case "text":
        return this.textDisplay(block.content, [...path, "content"]);
      case "section": {
        let accessory: APISectionAccessoryComponent;
        if (block.accessory.type === "thumbnail") {
          const description = this.plainText(block.accessory.description, 1024, "the image description", [...path, "accessory", "description"]);
          accessory = {
            type: ComponentType.Thumbnail,
            media: { url: this.requiredImage(block.accessory.url, [...path, "accessory", "url"]) },
            spoiler: block.accessory.spoiler,
            ...(description ? { description } : {}),
          };
        } else {
          accessory = this.button(block.accessory.button, [...path, "accessory", "button"]);
        }
        return {
          type: ComponentType.Section,
          components: block.texts.map((text, i) => this.textDisplay(text, [...path, "texts", i])),
          accessory,
        };
      }
      case "gallery":
        return {
          type: ComponentType.MediaGallery,
          items: block.items.map((item, i) => {
            const description = this.plainText(item.description, 1024, "the image description", [...path, "items", i, "description"]);
            return {
              media: { url: this.requiredImage(item.url, [...path, "items", i, "url"]) },
              spoiler: item.spoiler,
              ...(description ? { description } : {}),
            };
          }),
        };
      case "separator":
        return {
          type: ComponentType.Separator,
          divider: block.divider,
          spacing: block.spacing === "large" ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small,
        };
      case "file":
        return { type: ComponentType.File, file: { url: this.attach(block.asset_id, [...path, "asset_id"]) }, spoiler: block.spoiler };
      case "row":
        return this.row(block.row, [...path, "row"]);
    }
  }

  block(block: KitBlock, path: Path): APIMessageTopLevelComponent {
    if (block.type !== "container") return this.leaf(block, path) as APIMessageTopLevelComponent;
    return {
      type: ComponentType.Container,
      spoiler: block.spoiler,
      ...(block.accent_color !== null ? { accent_color: block.accent_color } : {}),
      components: block.children.map((child, i) => this.leaf(child, [...path, "children", i])),
    };
  }
}

const BUTTON_STYLE: Record<
  Exclude<KitButton["style"], "link">,
  ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger
> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export function toApiEmoji(raw: string): APIMessageComponentEmoji | undefined {
  const parsed = parseComponentEmoji(raw);
  if (!parsed) return undefined;
  if (typeof parsed === "string") return { name: parsed };
  return { id: parsed.id, ...(parsed.name ? { name: parsed.name } : {}), ...(parsed.animated ? { animated: true } : {}) };
}

function allowedMentions(doc: KitDocument): KitMessageBody["allowedMentions"] {
  const parse: ("users" | "roles" | "everyone")[] = [];
  if (doc.mentions.users) parse.push("users");
  if (doc.mentions.roles) parse.push("roles");
  if (doc.mentions.everyone) parse.push("everyone");
  return { parse };
}

function textTotal(components: (APIMessageTopLevelComponent | APIComponentInContainer)[]): number {
  let total = 0;
  for (const component of components) {
    if (component.type === ComponentType.TextDisplay) total += component.content.length;
    else if (component.type === ComponentType.Section) total += textTotal(component.components);
    else if (component.type === ComponentType.Container) total += textTotal(component.components);
  }
  return total;
}

/** Renders a (validated) document. Throws KitRenderError when it can't be sent as it stands. */
export function renderKit(doc: KitDocument, ctx: RenderContext): RenderedKit {
  const r = new Renderer(ctx);
  let flags = doc.flags.silent ? MessageFlags.SuppressNotifications : 0;

  if (doc.format === "v2") {
    const components = doc.blocks.map((block, i) => r.block(block, ["blocks", i]));
    const text = textTotal(components);
    if (text > 4000) throw tooLong("the text", text, 4000, ["blocks"]);
    flags |= MessageFlags.IsComponentsV2;
    return { format: "v2", body: { components, flags, allowedMentions: allowedMentions(doc) }, assetIds: r.assetIds };
  }

  const content = r.md(doc.content, 2000, "the message text", ["content"]);
  const embeds = doc.embeds.map((embed, i) => r.embed(embed, ["embeds", i]));
  const embedChars = embeds.reduce(
    (sum, embed) =>
      sum +
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.text.length ?? 0) +
      (embed.author?.name.length ?? 0) +
      (embed.fields ?? []).reduce((acc, field) => acc + field.name.length + field.value.length, 0),
    0,
  );
  if (embedChars > 6000) throw tooLong("the embeds", embedChars, 6000, ["embeds"]);
  const components = doc.rows.map((row, i) => r.row(row, ["rows", i]));
  for (const assetId of doc.attachments) r.attach(assetId, ["attachments"]);
  if (doc.flags.suppress_embeds && embeds.length === 0) flags |= MessageFlags.SuppressEmbeds;
  if (!content && embeds.length === 0 && r.assetIds.length === 0)
    throw new KitRenderError("With placeholders filled in, this message is empty.", "content");

  return {
    format: "classic",
    body: {
      ...(content ? { content } : {}),
      embeds,
      components,
      flags,
      allowedMentions: allowedMentions(doc),
    },
    assetIds: r.assetIds,
  };
}
