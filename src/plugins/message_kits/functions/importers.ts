import { coerceKitDocument, defaultKitDocument, isHttpUrl, parseKitDocument, type KitBlock, type KitButton, type KitDocument, type KitEmbed, type KitLeafBlock, type KitRow } from "./document.js";

/**
 * Turns other message formats into a KitDocument: a Discord message (API JSON, from a link or a
 * message the bot fetched), Discohook / Embed Generator JSON (`{ content, embeds, components }`,
 * Discohook backups `{ messages: [{ data }] }`), or a KitDocument export. Pure, so it's tested.
 *
 * Interactive buttons and menus can't be imported (their actions live in the other bot), so only
 * link buttons survive; everything dropped is reported as a warning.
 */

export class KitImportError extends Error {}

const EVERYONE_OFF = "@everyone and @here pings were turned off. Turn them on in the kit's settings if you want them.";

export type KitImport = { document: KitDocument; warnings: string[] };

type Json = Record<string, unknown>;

const FLAG_SUPPRESS_EMBEDS = 1 << 2;
const FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;
const FLAG_COMPONENTS_V2 = 1 << 15;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

class Converter {
  readonly warnings = new Set<string>();
  private ids = new Map<string, number>();

  nextId(base: string): string {
    const n = (this.ids.get(base) ?? 0) + 1;
    this.ids.set(base, n);
    return `${base}-${n}`;
  }

  image(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : isObject(value) ? str(value.url, 2048).trim() : "";
    if (!url) return "";
    if (url.startsWith("attachment://")) {
      this.warnings.add("Images that were uploaded with the message can't be imported. Upload them to the asset library and pick them again.");
      return "";
    }
    if (!isHttpUrl(url) || url.length > 2048) return "";
    if (/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/(attachments|ephemeral-attachments)\//.test(url))
      this.warnings.add("Some images link to files uploaded to Discord, and those links expire. Upload them to the asset library to keep them working.");
    return url;
  }

  link(value: unknown): string {
    const url = str(value, 2048).trim();
    return url && isHttpUrl(url) ? url : "";
  }

  emoji(value: unknown): string {
    if (!isObject(value)) return typeof value === "string" ? value.slice(0, 100) : "";
    const name = str(value.name, 64);
    if (typeof value.id === "string" && /^\d{5,25}$/.test(value.id)) return `<${value.animated ? "a" : ""}:${name || "emoji"}:${value.id}>`;
    return name;
  }

  embed(raw: Json): KitEmbed | null {
    if (raw.type !== undefined && raw.type !== "rich") {
      this.warnings.add("Link previews were skipped (Discord adds those by itself).");
      return null;
    }
    const author = isObject(raw.author) ? raw.author : {};
    const footer = isObject(raw.footer) ? raw.footer : {};
    const rawFields = Array.isArray(raw.fields) ? raw.fields.filter(isObject) : [];
    if (rawFields.length > 25) this.warnings.add("Embeds can have 25 fields; the rest were dropped.");
    const fields = rawFields
      .slice(0, 25)
      .map((field) => ({ name: str(field.name, 256).trim(), value: str(field.value, 1024).trim(), inline: bool(field.inline) }))
      .filter((field) => field.name && field.value);
    const timestamp = typeof raw.timestamp === "string" && !Number.isNaN(Date.parse(raw.timestamp)) ? new Date(raw.timestamp).toISOString() : "none";
    const color = typeof raw.color === "number" && Number.isInteger(raw.color) && raw.color >= 0 && raw.color <= 0xffffff ? raw.color : null;
    return {
      title: str(raw.title, 256),
      url: this.link(raw.url),
      description: str(raw.description, 4096),
      color,
      author: { name: str(author.name, 256), url: this.link(author.url), icon_url: this.image(author.icon_url) },
      thumbnail_url: this.image(raw.thumbnail),
      image_url: this.image(raw.image),
      footer: { text: str(footer.text, 2048), icon_url: this.image(footer.icon_url) },
      timestamp,
      fields,
    };
  }

  /** A link button, or null (with a warning) for anything interactive. */
  button(raw: Json): KitButton | null {
    if (raw.style === 5 && typeof raw.url === "string" && /^(https?|discord):\/\//i.test(raw.url.trim())) {
      const label = str(raw.label, 80);
      const emoji = this.emoji(raw.emoji);
      if (!label && !emoji) return null;
      return { id: this.nextId("link"), label, emoji, style: "link", url: raw.url.trim().slice(0, 512), disabled: bool(raw.disabled), action: { type: "none" } };
    }
    this.warnings.add("Buttons and menus that do something when clicked can't be imported. Add them again in the builder.");
    return null;
  }

  row(raw: Json): KitRow | null {
    const components = Array.isArray(raw.components) ? raw.components.filter(isObject) : [];
    const buttons: KitButton[] = [];
    for (const component of components) {
      if (component.type === 2) {
        const button = this.button(component);
        if (button) buttons.push(button);
      } else {
        this.warnings.add("Buttons and menus that do something when clicked can't be imported. Add them again in the builder.");
      }
    }
    return buttons.length ? { type: "buttons", buttons: buttons.slice(0, 5) } : null;
  }

  texts(raw: unknown): string[] {
    return (Array.isArray(raw) ? raw.filter(isObject) : [])
      .filter((c) => c.type === 10)
      .map((c) => str(c.content, 4000))
      .filter((text) => text.trim());
  }

  leaf(raw: Json): KitLeafBlock[] {
    switch (raw.type) {
      case 10: {
        const content = str(raw.content, 4000);
        return content.trim() ? [{ type: "text", content }] : [];
      }
      case 9: {
        const texts = this.texts(raw.components).slice(0, 3);
        const accessory = isObject(raw.accessory) ? raw.accessory : null;
        if (accessory?.type === 11) {
          const url = this.image(accessory.media);
          if (url && texts.length)
            return [
              {
                type: "section",
                texts,
                accessory: { type: "thumbnail", url, description: str(accessory.description, 1024), spoiler: bool(accessory.spoiler) },
              },
            ];
        } else if (accessory?.type === 2) {
          const button = this.button(accessory);
          if (button && texts.length) return [{ type: "section", texts, accessory: { type: "button", button } }];
        }
        // Without a usable accessory a section can't exist; keep its text.
        return texts.map((content) => ({ type: "text" as const, content }));
      }
      case 12: {
        const items = (Array.isArray(raw.items) ? raw.items.filter(isObject) : [])
          .map((item) => ({ url: this.image(item.media), description: str(item.description, 1024), spoiler: bool(item.spoiler) }))
          .filter((item) => item.url)
          .slice(0, 10);
        return items.length ? [{ type: "gallery", items }] : [];
      }
      case 13:
        this.warnings.add("Files attached to the message can't be imported. Upload them to the asset library and add them again.");
        return [];
      case 14:
        return [{ type: "separator", divider: raw.divider !== false, spacing: raw.spacing === 2 ? "large" : "small" }];
      case 1: {
        const row = this.row(raw);
        return row ? [{ type: "row", row }] : [];
      }
      default:
        this.warnings.add("Some parts of the layout aren't supported and were skipped.");
        return [];
    }
  }

  blocks(raw: unknown[]): KitBlock[] {
    const blocks: KitBlock[] = [];
    for (const component of raw.filter(isObject)) {
      if (component.type === 17) {
        const children = (Array.isArray(component.components) ? component.components.filter(isObject) : []).flatMap((child) =>
          child.type === 17 ? [] : this.leaf(child),
        );
        if (!children.length) continue;
        const accent = component.accent_color;
        blocks.push({
          type: "container",
          accent_color: typeof accent === "number" && Number.isInteger(accent) && accent >= 0 && accent <= 0xffffff ? accent : null,
          spoiler: bool(component.spoiler),
          children: children.slice(0, 39),
        });
      } else {
        blocks.push(...this.leaf(component));
      }
    }
    return blocks;
  }
}

/** Converts Discord message JSON (API shape: content, embeds, components, flags; plus Discohook's
 *  username / avatar_url / thread_name) into a document. */
export function documentFromMessageData(data: unknown): KitImport {
  const c = new Converter();
  if (!isObject(data)) throw new KitImportError("That doesn't look like a message.");
  const flags = typeof data.flags === "number" ? data.flags : 0;
  const components = Array.isArray(data.components) ? data.components : [];
  const isV2 = (flags & FLAG_COMPONENTS_V2) !== 0 || components.some((component) => isObject(component) && typeof component.type === "number" && component.type >= 9);

  const doc: Json = { format: isV2 ? "v2" : "classic" };
  if (isV2) {
    const blocks = c.blocks(components);
    if (blocks.length > 40) c.warnings.add("A message can have 40 components; the rest were dropped.");
    doc.blocks = blocks.slice(0, 40);
  } else {
    const content = typeof data.content === "string" ? data.content : "";
    if (content.length > 2000) c.warnings.add("The message text was cut to 2000 characters.");
    doc.content = content.slice(0, 2000);
    const rawEmbeds = Array.isArray(data.embeds) ? data.embeds.filter(isObject) : [];
    const embeds = rawEmbeds.map((embed) => c.embed(embed)).filter((embed): embed is KitEmbed => embed !== null);
    if (embeds.length > 10) c.warnings.add("A message can have 10 embeds; the rest were dropped.");
    doc.embeds = embeds.slice(0, 10);
    const rows = components.filter(isObject).map((row) => (row.type === 1 ? c.row(row) : null));
    doc.rows = rows.filter((row): row is KitRow => row !== null).slice(0, 5);
    if (Array.isArray(data.attachments) && data.attachments.length > 0)
      c.warnings.add("Files attached to the message can't be imported. Upload them to the asset library and add them again.");
  }

  const username = str(data.username, 80);
  const avatar = c.image(data.avatar_url);
  if (username || avatar) doc.identity = { mode: "webhook", name: username, avatar_url: avatar };
  doc.flags = {
    silent: (flags & FLAG_SUPPRESS_NOTIFICATIONS) !== 0,
    suppress_embeds: !isV2 && (flags & FLAG_SUPPRESS_EMBEDS) !== 0 && (doc.embeds as unknown[]).length === 0,
  };
  if (typeof data.thread_name === "string") doc.thread_name = data.thread_name.slice(0, 100);
  const mentions = isObject(data.allowed_mentions) ? data.allowed_mentions : null;
  if (mentions && Array.isArray(mentions.parse)) {
    // @everyone / @here pings are never switched on by an import (a shared template could
    // carry them unnoticed); whoever saves the kit turns them on in the builder.
    doc.mentions = { users: mentions.parse.includes("users"), roles: mentions.parse.includes("roles"), everyone: false };
    if (mentions.parse.includes("everyone")) c.warnings.add(EVERYONE_OFF);
  }

  const document = coerceKitDocument(doc) ?? defaultKitDocument(isV2 ? "v2" : "classic");
  return finish(document, [...c.warnings]);
}

/** Adds "fix before saving" warnings for anything the result still breaks. */
function finish(document: KitDocument, warnings: string[]): KitImport {
  const check = parseKitDocument(document);
  if (!check.ok) {
    for (const issue of check.issues.slice(0, 10)) warnings.push(`Fix before saving${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`);
  }
  return { document, warnings };
}

function looksNative(value: Json): boolean {
  return (value.format === "classic" || value.format === "v2") && ("blocks" in value || "rows" in value || "identity" in value);
}

/** Imports pasted JSON: a KitDocument (or `{ document }` export), a Discohook backup or share,
 *  Embed Generator / plain message JSON, or a bare array of embeds. */
export function importKitJson(text: string): KitImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KitImportError("That isn't valid JSON.");
  }

  if (Array.isArray(parsed)) {
    if (!parsed.length || !parsed.every(isObject)) throw new KitImportError("Expected a message, an embed list or a kit.");
    return documentFromMessageData({ embeds: parsed });
  }
  if (!isObject(parsed)) throw new KitImportError("Expected a message, an embed list or a kit.");

  const native = isObject(parsed.document) && looksNative(parsed.document) ? parsed.document : looksNative(parsed) ? parsed : null;
  if (native) {
    const document = coerceKitDocument(native);
    if (!document) {
      const check = parseKitDocument(native);
      const first = check.ok ? null : check.issues[0];
      throw new KitImportError(`That kit couldn't be read${first ? ` (${first.path || "document"}: ${first.message})` : ""}.`);
    }
    if (!document.mentions.everyone) return finish(document, []);
    return finish({ ...document, mentions: { ...document.mentions, everyone: false } }, [EVERYONE_OFF]);
  }

  // Discohook backups and share links: { messages: [{ data: {...} }] } (older ones: { message: {...} }).
  if (Array.isArray(parsed.messages)) {
    const messages = parsed.messages.filter(isObject);
    const first = messages[0];
    if (!first) throw new KitImportError("That backup has no messages.");
    const result = documentFromMessageData(isObject(first.data) ? first.data : first);
    if (messages.length > 1) result.warnings.unshift(`Only the first of ${messages.length} messages was imported.`);
    return result;
  }
  if (isObject(parsed.message)) return documentFromMessageData(parsed.message);
  if (isObject(parsed.data) && ("content" in parsed.data || "embeds" in parsed.data || "components" in parsed.data))
    return documentFromMessageData(parsed.data);
  if (!("content" in parsed) && !("embeds" in parsed) && !("components" in parsed)) {
    // A single embed object.
    if ("title" in parsed || "description" in parsed || "fields" in parsed) return documentFromMessageData({ embeds: [parsed] });
    throw new KitImportError("Expected a message with content, embeds or components.");
  }
  return documentFromMessageData(parsed);
}
