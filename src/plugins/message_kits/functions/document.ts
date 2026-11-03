import { z } from "zod";
import { KIT_LIMITS } from "./constants.js";

/**
 * KitDocument: the saved shape of one Message Kit. This zod schema is the source of truth for the
 * bot ⇄ website contract (the site mirrors the type in src/lib/messageKits.ts). Everything here is
 * pure (no discord.js, no database) so it's shared by the bridge, the renderer and the tests.
 *
 * Field-level rules mirror Discord's own limits; the cross-field rules in `superRefine` cover what
 * a single field can't (6000 embed characters, 40 V2 components, unique component ids, ...). Every
 * issue carries a precise path such as `embeds[0].fields[2].value` so the builder can point at it.
 */

// ── Primitives ──────────────────────────────────────────────────────────────

export const SNOWFLAKE_RE = /^\d{15,25}$/;
export const ASSET_ID_RE = /^[a-f0-9]{16}$/;
export const COMPONENT_ID_RE = /^[a-z0-9_-]{1,24}$/;
const PLACEHOLDER_ONLY_RE = /^\{\w+\}$/;

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** `asset:<id>` → the id, else null. */
export function assetIdOf(value: string): string | null {
  const match = /^asset:([a-f0-9]{16})$/.exec(value.trim());
  return match ? match[1]! : null;
}

/** "" (none), an http(s) link, an uploaded asset (`asset:<id>`), or one placeholder like `{guild_icon_url}`. */
const zImage = z
  .string()
  .max(2048)
  .default("")
  .refine(
    (value) => {
      const v = value.trim();
      return !v || isHttpUrl(v) || assetIdOf(v) !== null || PLACEHOLDER_ONLY_RE.test(v);
    },
    { message: "Use an image link starting with https://, or pick an uploaded image." },
  );

const zOptionalUrl = z
  .string()
  .max(2048)
  .default("")
  .refine((value) => !value.trim() || isHttpUrl(value.trim()), { message: "Links must start with https:// or http://." });

const zSnowflake = z.string().regex(SNOWFLAKE_RE, "That isn't a valid Discord ID.");
const zComponentId = z.string().regex(COMPONENT_ID_RE, "Ids are 1-24 lowercase letters, numbers, - or _.");
const zColor = z.number().int().min(0).max(0xffffff).nullable().default(null);
const zEmoji = z.string().max(100).default("");

/**
 * Drafts: a kit can be saved half-built (a new blank kit, a button without a label yet), so while
 * `draftParse` is on, the "still empty" rules are skipped. Discord's limits, link and id formats
 * and everything about safety still apply. Sending always parses strictly.
 */
let draftParse = false;
const filled = (value: string | unknown[]) => draftParse || value.length > 0;
/** A required id that may still be blank ("") in a draft. */
const zRequiredSnowflake = (message: string) =>
  z.string().default("").refine((value) => (draftParse && value === "") || SNOWFLAKE_RE.test(value), { message });

// ── Actions ─────────────────────────────────────────────────────────────────

const zFormField = z.object({
  id: zComponentId,
  label: z.string().trim().max(45).refine(filled, "Give the question a label."),
  style: z.enum(["short", "paragraph"]).default("short"),
  required: z.boolean().default(true),
  placeholder: z.string().max(100).default(""),
  min: z.number().int().min(0).max(4000).default(0),
  max: z.number().int().min(1).max(4000).default(1000),
});

const zActionNone = z.object({ type: z.literal("none") });
const zActionRole = z.object({
  type: z.literal("role"),
  mode: z.enum(["add", "remove", "toggle"]).default("toggle"),
  role_ids: z
    .array(zSnowflake)
    .max(KIT_LIMITS.roleActionRoles, `At most ${KIT_LIMITS.roleActionRoles} roles.`)
    .default([])
    .refine(filled, "Pick at least one role."),
  reply: z.string().max(2000).default(""),
});
const zActionKit = z.object({
  type: z.literal("kit"),
  kit_id: z.number().int().min(0).default(0).refine((value) => draftParse || value > 0, "Pick a kit to reply with."),
});
const zActionForm = z.object({
  type: z.literal("form"),
  title: z.string().trim().max(45).default("").refine(filled, "Give the form a title."),
  fields: z
    .array(zFormField)
    .max(KIT_LIMITS.formFields, `At most ${KIT_LIMITS.formFields} questions.`)
    .default([])
    .refine(filled, "Add at least one question."),
  channel_id: zRequiredSnowflake("Pick a channel for the answers."),
  ping_role_id: zSnowflake.nullable().default(null),
  confirmation: z.string().max(2000).default(""),
});

export const zKitAction = z.discriminatedUnion("type", [zActionNone, zActionRole, zActionKit, zActionForm]);
const zActionDefault = zKitAction.default({ type: "none" });

// ── Components ──────────────────────────────────────────────────────────────

export const BUTTON_STYLES = ["primary", "secondary", "success", "danger", "link"] as const;

const zButton = z.object({
  id: zComponentId,
  label: z.string().max(80).default(""),
  emoji: zEmoji,
  style: z.enum(BUTTON_STYLES).default("primary"),
  url: z.string().max(512).default(""),
  disabled: z.boolean().default(false),
  action: zActionDefault,
});

const zSelectOption = z.object({
  id: zComponentId,
  label: z.string().trim().max(100).refine(filled, "Give the option a label."),
  description: z.string().max(100).default(""),
  emoji: zEmoji,
  action: zActionDefault,
});

const zSelect = z.object({
  id: zComponentId,
  placeholder: z.string().max(150).default(""),
  min_values: z.number().int().min(0).max(25).default(1),
  max_values: z.number().int().min(1).max(25).default(1),
  disabled: z.boolean().default(false),
  options: z.array(zSelectOption).max(25, "At most 25 options.").default([]).refine(filled, "Add at least one option."),
});

const zButtonsRow = z.object({
  type: z.literal("buttons"),
  buttons: z.array(zButton).max(5, "At most 5 buttons per row.").default([]).refine(filled, "Add at least one button."),
});
const zSelectRow = z.object({ type: z.literal("select"), select: zSelect });
export const zKitRow = z.discriminatedUnion("type", [zButtonsRow, zSelectRow]);

// ── Embeds ──────────────────────────────────────────────────────────────────

export const zKitEmbed = z.object({
  title: z.string().max(256).default(""),
  url: zOptionalUrl,
  description: z.string().max(4096).default(""),
  color: zColor,
  author: z
    .object({ name: z.string().max(256).default(""), url: zOptionalUrl, icon_url: zImage })
    .default({}),
  thumbnail_url: zImage,
  image_url: zImage,
  footer: z.object({ text: z.string().max(2048).default(""), icon_url: zImage }).default({}),
  timestamp: z
    .string()
    .default("none")
    .refine((value) => value === "none" || value === "now" || !Number.isNaN(Date.parse(value)), {
      message: "Use none, now or an ISO date.",
    }),
  fields: z
    .array(
      z.object({
        name: z.string().trim().max(256).default("").refine(filled, "Fields need a name."),
        value: z.string().trim().max(1024).default("").refine(filled, "Fields need a value."),
        inline: z.boolean().default(false),
      }),
    )
    .max(25, "At most 25 fields per embed.")
    .default([]),
});

// ── Components V2 blocks ────────────────────────────────────────────────────

const zTextBlock = z.object({ type: z.literal("text"), content: z.string().trim().max(4000).default("").refine(filled, "Text blocks can't be empty.") });
const zSectionBlock = z.object({
  type: z.literal("section"),
  texts: z
    .array(z.string().trim().max(4000).refine(filled, "Section text can't be empty."))
    .max(3, "A section needs 1-3 texts.")
    .default([""])
    .refine(filled, "A section needs 1-3 texts."),
  accessory: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("thumbnail"),
      url: zImage.refine((value) => draftParse || value.trim() !== "", { message: "Pick an image for the thumbnail." }),
      description: z.string().max(1024).default(""),
      spoiler: z.boolean().default(false),
    }),
    z.object({ type: z.literal("button"), button: zButton }),
  ]),
});
const zGalleryBlock = z.object({
  type: z.literal("gallery"),
  items: z
    .array(
      z.object({
        url: zImage.refine((value) => draftParse || value.trim() !== "", { message: "Pick an image." }),
        description: z.string().max(1024).default(""),
        spoiler: z.boolean().default(false),
      }),
    )
    .max(10, "A gallery needs 1-10 images.")
    .default([])
    .refine(filled, "A gallery needs 1-10 images."),
});
const zSeparatorBlock = z.object({
  type: z.literal("separator"),
  divider: z.boolean().default(true),
  spacing: z.enum(["small", "large"]).default("small"),
});
const zFileBlock = z.object({
  type: z.literal("file"),
  asset_id: z.string().default("").refine((value) => (draftParse && value === "") || ASSET_ID_RE.test(value), "Pick an uploaded file."),
  spoiler: z.boolean().default(false),
});
const zRowBlock = z.object({ type: z.literal("row"), row: zKitRow });

const LEAF_BLOCKS = [zTextBlock, zSectionBlock, zGalleryBlock, zSeparatorBlock, zFileBlock, zRowBlock] as const;
const zLeafBlock = z.discriminatedUnion("type", [...LEAF_BLOCKS]);
const zContainerBlock = z.object({
  type: z.literal("container"),
  accent_color: zColor,
  spoiler: z.boolean().default(false),
  children: z.array(zLeafBlock).max(39).default([]).refine(filled, "A container needs at least one block."),
});
export const zKitBlock = z.discriminatedUnion("type", [...LEAF_BLOCKS, zContainerBlock]);

// ── Document ────────────────────────────────────────────────────────────────

const zKitDocumentShape = z.object({
  format: z.enum(["classic", "v2"]).default("classic"),
  content: z.string().max(2000, "Message text can be at most 2000 characters.").default(""),
  embeds: z.array(zKitEmbed).max(10, "At most 10 embeds.").default([]),
  rows: z.array(zKitRow).max(5, "At most 5 rows of buttons or menus.").default([]),
  blocks: z.array(zKitBlock).max(100, "At most 40 components.").default([]),
  attachments: z.array(z.string().regex(ASSET_ID_RE, "Pick an uploaded file.")).max(10, "At most 10 files.").default([]),
  identity: z
    .object({
      mode: z.enum(["bot", "webhook"]).default("bot"),
      name: z.string().max(80).default(""),
      avatar_url: zImage,
    })
    .default({}),
  mentions: z
    .object({ users: z.boolean().default(true), roles: z.boolean().default(false), everyone: z.boolean().default(false) })
    .default({}),
  flags: z.object({ silent: z.boolean().default(false), suppress_embeds: z.boolean().default(false) }).default({}),
  thread_name: z.string().max(100).default(""),
});

export type KitAction = z.infer<typeof zKitAction>;
export type KitButton = z.infer<typeof zButton>;
export type KitSelect = z.infer<typeof zSelect>;
export type KitSelectOption = z.infer<typeof zSelectOption>;
export type KitRow = z.infer<typeof zKitRow>;
export type KitEmbed = z.infer<typeof zKitEmbed>;
export type KitBlock = z.infer<typeof zKitBlock>;
export type KitLeafBlock = z.infer<typeof zLeafBlock>;
export type KitFormAction = z.infer<typeof zActionForm>;
export type KitDocument = z.infer<typeof zKitDocumentShape>;

// ── Counting helpers (Discord limits) ───────────────────────────────────────

/** Characters Discord counts towards the 6000 limit: titles, descriptions, field names and values, footers, author names. */
export function embedCharCount(embed: KitEmbed): number {
  return (
    embed.title.length +
    embed.description.length +
    embed.footer.text.length +
    embed.author.name.length +
    embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

function rowComponentCount(row: KitRow): number {
  return 1 + (row.type === "buttons" ? row.buttons.length : 1);
}

/** Every component a V2 block becomes, nested ones included (Discord allows 40 per message). */
export function countBlockComponents(block: KitBlock): number {
  switch (block.type) {
    case "text":
    case "gallery":
    case "separator":
    case "file":
      return 1;
    case "section":
      return 1 + block.texts.length + 1;
    case "row":
      return rowComponentCount(block.row);
    case "container":
      return 1 + block.children.reduce((sum, child) => sum + countBlockComponents(child), 0);
  }
}

export function countV2Components(blocks: KitBlock[]): number {
  return blocks.reduce((sum, block) => sum + countBlockComponents(block), 0);
}

/** Text across every text display (sections included), which Discord caps at 4000 per message. */
export function v2TextLength(blocks: KitBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text") total += block.content.length;
    else if (block.type === "section") total += block.texts.reduce((sum, text) => sum + text.length, 0);
    else if (block.type === "container") total += v2TextLength(block.children);
  }
  return total;
}

// ── Walking components ──────────────────────────────────────────────────────

export type KitComponentRef =
  | { kind: "button"; button: KitButton; path: (string | number)[] }
  | { kind: "select"; select: KitSelect; path: (string | number)[] };

function rowRefs(row: KitRow, path: (string | number)[]): KitComponentRef[] {
  if (row.type === "buttons") return row.buttons.map((button, i) => ({ kind: "button", button, path: [...path, "buttons", i] }));
  return [{ kind: "select", select: row.select, path: [...path, "select"] }];
}

function blockRefs(blocks: KitBlock[], path: (string | number)[]): KitComponentRef[] {
  const refs: KitComponentRef[] = [];
  blocks.forEach((block, i) => {
    const here = [...path, i];
    if (block.type === "row") refs.push(...rowRefs(block.row, [...here, "row"]));
    else if (block.type === "section" && block.accessory.type === "button")
      refs.push({ kind: "button", button: block.accessory.button, path: [...here, "accessory", "button"] });
    else if (block.type === "container") refs.push(...blockRefs(block.children, [...here, "children"]));
  });
  return refs;
}

/** Every button and select the document's active format renders, with its path. */
export function listComponents(doc: KitDocument): KitComponentRef[] {
  if (doc.format === "v2") return blockRefs(doc.blocks, ["blocks"]);
  return doc.rows.flatMap((row, i) => rowRefs(row, ["rows", i]));
}

export function findComponent(doc: KitDocument, componentId: string): KitComponentRef | null {
  return (
    listComponents(doc).find((ref) => (ref.kind === "button" ? ref.button.id : ref.select.id) === componentId) ?? null
  );
}

/** Every action the document's components can run (link buttons excluded). */
export function listActions(doc: KitDocument): KitAction[] {
  const actions: KitAction[] = [];
  for (const ref of listComponents(doc)) {
    if (ref.kind === "button") {
      if (ref.button.style !== "link") actions.push(ref.button.action);
    } else {
      for (const option of ref.select.options) actions.push(option.action);
    }
  }
  return actions;
}

/** True when any button or menu does something when clicked (needs interactions, not just links). */
export function hasInteractiveComponents(doc: KitDocument): boolean {
  return listComponents(doc).some((ref) => ref.kind === "select" || ref.button.style !== "link");
}

function imagesOfEmbed(embed: KitEmbed): string[] {
  return [embed.author.icon_url, embed.thumbnail_url, embed.image_url, embed.footer.icon_url];
}

function imagesOfBlocks(blocks: KitBlock[]): string[] {
  const urls: string[] = [];
  for (const block of blocks) {
    if (block.type === "section" && block.accessory.type === "thumbnail") urls.push(block.accessory.url);
    else if (block.type === "gallery") urls.push(...block.items.map((item) => item.url));
    else if (block.type === "container") urls.push(...imagesOfBlocks(block.children));
  }
  return urls;
}

function fileBlockIds(blocks: KitBlock[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.type === "file") ids.push(block.asset_id);
    else if (block.type === "container") ids.push(...fileBlockIds(block.children));
  }
  return ids;
}

/** Assets the message itself attaches (files + images), in first-use order, without duplicates. */
export function messageAssetIds(doc: KitDocument): string[] {
  const ids =
    doc.format === "v2"
      ? [...imagesOfBlocks(doc.blocks).map(assetIdOf), ...fileBlockIds(doc.blocks)]
      : [...doc.embeds.flatMap(imagesOfEmbed).map(assetIdOf), ...doc.attachments];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Every asset the document references anywhere (both formats and the identity avatar), for "in use" checks. */
export function referencedAssetIds(doc: KitDocument): string[] {
  const ids = [
    ...doc.embeds.flatMap(imagesOfEmbed).map(assetIdOf),
    ...doc.attachments,
    ...imagesOfBlocks(doc.blocks).map(assetIdOf),
    ...fileBlockIds(doc.blocks),
    assetIdOf(doc.identity.avatar_url),
  ];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Every action the active format can run, with the path of its `action` (for server checks). */
export function listActionRefs(doc: KitDocument): { action: KitAction; path: (string | number)[] }[] {
  const refs: { action: KitAction; path: (string | number)[] }[] = [];
  for (const ref of listComponents(doc)) {
    if (ref.kind === "button") {
      if (ref.button.style !== "link") refs.push({ action: ref.button.action, path: [...ref.path, "action"] });
    } else {
      ref.select.options.forEach((option, i) => refs.push({ action: option.action, path: [...ref.path, "options", i, "action"] }));
    }
  }
  return refs;
}

/** Every uploaded asset the active format sends (plus the webhook avatar), with its path and
 *  whether it's used as an image. */
export function listAssetRefs(doc: KitDocument): { assetId: string; path: (string | number)[]; image: boolean }[] {
  const refs: { assetId: string; path: (string | number)[]; image: boolean }[] = [];
  const image = (value: string, path: (string | number)[]) => {
    const id = assetIdOf(value);
    if (id) refs.push({ assetId: id, path, image: true });
  };
  const walk = (blocks: KitBlock[], base: (string | number)[]) =>
    blocks.forEach((block, i) => {
      const here = [...base, i];
      if (block.type === "section" && block.accessory.type === "thumbnail") image(block.accessory.url, [...here, "accessory", "url"]);
      else if (block.type === "gallery") block.items.forEach((item, j) => image(item.url, [...here, "items", j, "url"]));
      else if (block.type === "file") refs.push({ assetId: block.asset_id, path: [...here, "asset_id"], image: false });
      else if (block.type === "container") walk(block.children, [...here, "children"]);
    });
  if (doc.format === "v2") walk(doc.blocks, ["blocks"]);
  else {
    doc.embeds.forEach((embed, i) => {
      image(embed.author.icon_url, ["embeds", i, "author", "icon_url"]);
      image(embed.thumbnail_url, ["embeds", i, "thumbnail_url"]);
      image(embed.image_url, ["embeds", i, "image_url"]);
      image(embed.footer.icon_url, ["embeds", i, "footer", "icon_url"]);
    });
    doc.attachments.forEach((id, i) => refs.push({ assetId: id, path: ["attachments", i], image: false }));
  }
  if (doc.identity.mode === "webhook") image(doc.identity.avatar_url, ["identity", "avatar_url"]);
  return refs;
}

// ── Cross-field validation ──────────────────────────────────────────────────

const LINK_URL_RE = /^(https?|discord):\/\//i;

function checkAction(action: KitAction, path: (string | number)[], ctx: z.RefinementCtx): void {
  if (action.type !== "form") return;
  const seen = new Set<string>();
  action.fields.forEach((field, i) => {
    if (seen.has(field.id)) ctx.addIssue({ code: "custom", path: [...path, "fields", i, "id"], message: "Each question needs its own id." });
    seen.add(field.id);
    if (field.min > field.max)
      ctx.addIssue({ code: "custom", path: [...path, "fields", i, "min"], message: "The minimum length can't be more than the maximum." });
  });
}

function checkButton(button: KitButton, path: (string | number)[], ctx: z.RefinementCtx): void {
  if (!draftParse && !button.label.trim() && !button.emoji.trim())
    ctx.addIssue({ code: "custom", path: [...path, "label"], message: "Buttons need a label or an emoji." });
  if (button.style === "link") {
    if (!(draftParse && !button.url.trim()) && !LINK_URL_RE.test(button.url.trim()))
      ctx.addIssue({ code: "custom", path: [...path, "url"], message: "Link buttons need a link starting with https://." });
  } else {
    checkAction(button.action, [...path, "action"], ctx);
  }
}

function checkSelect(select: KitSelect, path: (string | number)[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  select.options.forEach((option, i) => {
    if (seen.has(option.id)) ctx.addIssue({ code: "custom", path: [...path, "options", i, "id"], message: "Each option needs its own id." });
    seen.add(option.id);
    checkAction(option.action, [...path, "options", i, "action"], ctx);
    if (select.max_values > 1 && (option.action.type === "kit" || option.action.type === "form"))
      ctx.addIssue({
        code: "custom",
        path: [...path, "options", i, "action"],
        message: "Menus that allow several choices can only add or remove roles. Set max choices to 1 to reply with a kit or open a form.",
      });
  });
  if (select.max_values > select.options.length)
    ctx.addIssue({ code: "custom", path: [...path, "max_values"], message: "Max choices can't be more than the number of options." });
  if (select.min_values > select.max_values)
    ctx.addIssue({ code: "custom", path: [...path, "min_values"], message: "Min choices can't be more than max choices." });
}

function checkComponents(doc: KitDocument, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const ref of listComponents(doc)) {
    const id = ref.kind === "button" ? ref.button.id : ref.select.id;
    if (seen.has(id)) ctx.addIssue({ code: "custom", path: [...ref.path, "id"], message: `Another button or menu already uses the id "${id}".` });
    seen.add(id);
    if (ref.kind === "button") checkButton(ref.button, ref.path, ctx);
    else checkSelect(ref.select, ref.path, ctx);
  }
}

const RESERVED_WEBHOOK_NAME = /discord|clyde/i;

export const zKitDocument = zKitDocumentShape.superRefine((doc, ctx) => {
  if (doc.format === "classic") {
    if (!draftParse && !doc.content.trim() && doc.embeds.length === 0 && doc.attachments.length === 0)
      ctx.addIssue({ code: "custom", path: ["content"], message: "Add some text, an embed or a file. Discord can't send an empty message." });
    const total = doc.embeds.reduce((sum, embed) => sum + embedCharCount(embed), 0);
    if (total > 6000)
      ctx.addIssue({ code: "custom", path: ["embeds"], message: `Embeds can hold 6000 characters in total (these have ${total}).` });
    doc.embeds.forEach((embed, i) => {
      const hasSomething =
        embedCharCount(embed) > 0 || imagesOfEmbed(embed).some((url) => url.trim() !== "");
      if (!draftParse && !hasSomething) ctx.addIssue({ code: "custom", path: ["embeds", i], message: "This embed is empty. Add a title, description, field or image." });
    });
    if (doc.flags.suppress_embeds && doc.embeds.length > 0)
      ctx.addIssue({ code: "custom", path: ["flags", "suppress_embeds"], message: "Hiding link previews would also hide this message's embeds." });
  } else {
    if (!draftParse && doc.blocks.length === 0) ctx.addIssue({ code: "custom", path: ["blocks"], message: "Add at least one block." });
    const components = countV2Components(doc.blocks);
    if (components > 40)
      ctx.addIssue({ code: "custom", path: ["blocks"], message: `A message can have 40 components in total, nested ones included (this has ${components}).` });
    const text = v2TextLength(doc.blocks);
    if (text > 4000)
      ctx.addIssue({ code: "custom", path: ["blocks"], message: `Text blocks can hold 4000 characters in total (these have ${text}).` });
  }
  checkComponents(doc, ctx);
  const files = messageAssetIds(doc).length;
  if (files > 10)
    ctx.addIssue({
      code: "custom",
      path: [doc.format === "v2" ? "blocks" : "attachments"],
      message: `A message can carry 10 uploaded files and images (this uses ${files}).`,
    });
  if (doc.identity.mode === "webhook" && RESERVED_WEBHOOK_NAME.test(doc.identity.name))
    ctx.addIssue({ code: "custom", path: ["identity", "name"], message: "Discord doesn't allow \"Discord\" or \"Clyde\" in webhook names." });
});

// ── Parsing ─────────────────────────────────────────────────────────────────

export type KitIssue = { path: string; message: string };

/** `["embeds", 0, "fields", 2, "value"]` → `embeds[0].fields[2].value`. */
export function formatIssuePath(path: (string | number)[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${part}` : part;
  }
  return out;
}

export function issuesFromZod(error: z.ZodError): KitIssue[] {
  const seen = new Set<string>();
  const issues: KitIssue[] = [];
  for (const issue of error.issues) {
    // Discriminated-union mismatches say "Invalid discriminator value"; reword for people.
    // (A container inside a container lands here too: container children are a narrower union.)
    const message =
      issue.code === "invalid_union_discriminator" ? `This kind of block isn't allowed here. Expected one of: ${issue.options.join(", ")}.` : issue.message;
    const entry = { path: formatIssuePath(issue.path), message };
    const key = `${entry.path}\n${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(entry);
  }
  return issues.slice(0, 50);
}

export type ParseKitResult = { ok: true; document: KitDocument } | { ok: false; issues: KitIssue[] };

/** Validates (and fills defaults into) a document from the dashboard, an import or the database. */
/** Runs a parse with the "still empty" rules off (see `draftParse`). Parsing is synchronous, so
 *  the flag can't leak into another parse. */
function asDraft<T>(run: () => T): T {
  draftParse = true;
  try {
    return run();
  } finally {
    draftParse = false;
  }
}

/** Strict: the document is complete and can be sent. */
export function parseKitDocument(input: unknown): ParseKitResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, issues: [{ path: "", message: "The document must be an object." }] };
  const result = zKitDocument.safeParse(input);
  return result.success ? { ok: true, document: result.data } : { ok: false, issues: issuesFromZod(result.error) };
}

/** For saving: every limit and format rule, but parts may still be empty (a new blank kit, a
 *  button without a label yet). Sending re-checks with parseKitDocument. */
export function parseKitDraft(input: unknown): ParseKitResult {
  return asDraft(() => parseKitDocument(input));
}

/** The document shape with defaults filled but none of the cross-field rules (for stored rows
 *  that predate a rule, saved drafts, and imports that are fixed up afterwards). */
export function coerceKitDocument(input: unknown): KitDocument | null {
  return asDraft(() => {
    const result = zKitDocumentShape.safeParse(input ?? {});
    return result.success ? result.data : null;
  });
}

export function defaultKitDocument(format: "classic" | "v2" = "classic"): KitDocument {
  return zKitDocumentShape.parse({ format });
}

export function emptyEmbed(): KitEmbed {
  return zKitEmbed.parse({});
}

// ── Summaries ───────────────────────────────────────────────────────────────

function plainSnippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstText(blocks: KitBlock[]): string {
  for (const block of blocks) {
    if (block.type === "text") return block.content;
    if (block.type === "section") return block.texts[0] ?? "";
    if (block.type === "container") {
      const inner = firstText(block.children);
      if (inner) return inner;
    }
  }
  return "";
}

/** The small preview shown on kit cards. */
export function kitPreview(doc: KitDocument): { title: string; snippet: string; color: number | null } {
  if (doc.format === "v2") {
    const text = firstText(doc.blocks);
    const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1] ?? "";
    const container = doc.blocks.find((block) => block.type === "container");
    return {
      title: plainSnippet(heading, 80),
      snippet: plainSnippet(heading ? text.replace(/^#{1,3}\s+.+$/m, "") : text),
      color: container?.type === "container" ? container.accent_color : null,
    };
  }
  const embed = doc.embeds[0];
  return {
    title: plainSnippet(embed?.title || embed?.author.name || "", 80),
    snippet: plainSnippet(doc.content || embed?.description || embed?.fields[0]?.value || ""),
    color: embed?.color ?? null,
  };
}
