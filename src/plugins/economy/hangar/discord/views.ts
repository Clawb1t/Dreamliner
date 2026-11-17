import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type TopLevelComponentData,
} from "discord.js";
import { baseEmbed } from "../../../../core/embeds.js";
import type { Translator } from "../../../../i18n/index.js";
import { formatAmount } from "../../functions/format.js";
import { getPlaneTypeById } from "../../functions/catalog.js";
import { RARITY_META, type Livery, type Rarity } from "../constants.js";
import type { CopyRow } from "../copies.js";
import { HangarError, ISO_TIME } from "../errors.js";
import { renderCopy, renderFace } from "../render.js";
import type { HangarCopyView } from "../view.js";
import { HE, buttonEmoji } from "./emojis.js";

export const HANGAR_PREFIX = "dl:hangar:";
/** Buttons from before the Hangar (pack confirm, inventory paging, stats, the old sell button). */
export const LEGACY_PLANE_PREFIXES = ["dl:planestats:", "dl:planepack:", "dl:planeinv:", "dl:planesell:"] as const;

export type V2Message = { components: TopLevelComponentData[]; files: AttachmentBuilder[]; flags: number };

export function v2(components: TopLevelComponentData[], files: AttachmentBuilder[] = [], ephemeral = false): V2Message {
  return { components, files, flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0) };
}

export function coins(amount: number): string {
  return `${HE.coin} \`$${formatAmount(amount)}\` coins`;
}

/** Coins as plain text, for button labels (no emoji markup or code spans). */
export function coinsLabel(amount: number): string {
  return `$${formatAmount(amount)} coins`;
}

export function parts(amount: number): string {
  return `${HE.parts} \`${Math.floor(amount).toLocaleString("en-US")}\` Parts`;
}

export function rarityLabel(rarity: string, t: Translator): string {
  const meta = RARITY_META[rarity as Rarity];
  return meta ? t(`economy.rarity.${rarity}`, meta.label) : rarity;
}

export function liveryLabel(livery: string, t: Translator): string {
  const labels: Record<string, string> = { standard: "Standard", gold: "Gold", prototype: "Prototype" };
  return t(`economy.hangar.livery.${livery}`, labels[livery] ?? livery);
}

/** "**Airbus A350** `#0042` Gold, First Edition, Lv 3" */
export function copyLine(view: HangarCopyView, t: Translator): string {
  const tags = [rarityLabel(view.card.rarity, t)];
  if (view.livery !== "standard") tags.push(liveryLabel(view.livery, t));
  if (view.firstEdition) tags.push(t("economy.hangar.firstEdition", "First Edition"));
  tags.push(t("economy.hangar.levelShort", "Lv {level}", { level: view.level }));
  const lock = view.locked ? ` ${HE.locked}` : "";
  return `**${view.card.name}** \`${view.serialLabel}\` ${tags.join(", ")}${lock}`;
}

/** Translates a Hangar rule error, keyed by its template so each message is translatable. */
export function errorText(error: HangarError, t: Translator): string {
  const slug = error.template.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
  // Timestamps become Discord timestamp tags, shown in each reader's own time zone.
  const vars: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(error.vars)) {
    if (typeof value === "string" && ISO_TIME.test(value)) {
      const unix = Math.floor(new Date(value).getTime() / 1000);
      vars[key] = `<t:${unix}:f> (<t:${unix}:R>)`;
    } else {
      vars[key] = value;
    }
  }
  return t(`economy.hangar.err.${slug}`, error.template, vars);
}

export function noticeContainer(title: string, body: string, tone: "success" | "error" | "info" = "info"): TopLevelComponentData {
  const emoji = tone === "success" ? HE.success : tone === "error" ? HE.error : HE.info;
  return baseEmbed().setTitle(`${emoji} ${title}`).setDescription(body).toContainerComponent();
}

export function notice(title: string, body: string, tone: "success" | "error" | "info" = "info", ephemeral = true): V2Message {
  return v2([noticeContainer(title, body, tone)], [], ephemeral);
}

export function errorMessage(error: unknown, t: Translator, ephemeral = true): V2Message | null {
  if (!(error instanceof HangarError)) return null;
  return notice(t("economy.hangar.errorTitle", "Couldn't do that"), errorText(error, t), "error", ephemeral);
}

/** Rendered faces as attachments plus one media gallery (Discord allows up to 10 items). */
export async function renderGallery(copies: CopyRow[]): Promise<{ gallery: TopLevelComponentData | null; files: AttachmentBuilder[] }> {
  const files: AttachmentBuilder[] = [];
  const items: { media: { url: string } }[] = [];
  for (const copy of copies.slice(0, 10)) {
    const card = getPlaneTypeById(copy.cardTypeId);
    if (!card) continue;
    try {
      const png = await renderCopy({ card, livery: copy.livery as Livery, firstEdition: copy.firstEdition, level: copy.level, serial: copy.serial });
      const name = `card-${copy.id}.png`;
      files.push(new AttachmentBuilder(png, { name }));
      items.push({ media: { url: `attachment://${name}` } });
    } catch {
      /* a failed render just leaves that card out of the gallery */
    }
  }
  return { gallery: items.length ? { type: ComponentType.MediaGallery, items } : null, files };
}

/** A card type's Standard face (catalog view). */
export async function renderTypeGallery(cardTypeId: number, livery: Livery = "standard"): Promise<{ gallery: TopLevelComponentData | null; files: AttachmentBuilder[] }> {
  const card = getPlaneTypeById(cardTypeId);
  if (!card) return { gallery: null, files: [] };
  try {
    const png = await renderFace({ card, livery, firstEdition: false, level: 1 });
    const name = `card-type-${card.id}.png`;
    return {
      gallery: { type: ComponentType.MediaGallery, items: [{ media: { url: `attachment://${name}` } }] },
      files: [new AttachmentBuilder(png, { name })],
    };
  } catch {
    return { gallery: null, files: [] };
  }
}

export function button(customId: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string, disabled = false): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label.slice(0, 80)).setStyle(style).setDisabled(disabled);
  if (emoji) b.setEmoji(buttonEmoji(emoji));
  return b;
}

export function row(...buttons: ButtonBuilder[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons).toJSON();
}

export function statsText(view: HangarCopyView, t: Translator): string {
  const s = view.effectiveStats;
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
  if (view.card.cardType === "airline") {
    return [
      `${t("economy.stat.reputation", "Reputation")} \`${fmt(s.reputation)}\``,
      `${t("economy.stat.safety", "Safety")} \`${fmt(s.safety)}\``,
      `${t("economy.stat.fleetSize", "Fleet Size")} \`${fmt(s.fleetSize)}\``,
      `${t("economy.stat.destinations", "Destinations")} \`${fmt(s.destinations)}\``,
    ].join("  ");
  }
  return [
    `${t("economy.stat.speed", "Speed")} \`${fmt(s.speed)}\``,
    `${t("economy.stat.agility", "Agility")} \`${fmt(s.agility)}\``,
    `${t("economy.stat.safety", "Safety")} \`${fmt(s.safety)}\``,
    `${t("economy.stat.passengers", "Passengers")} \`${fmt(s.passengerCount)}\``,
  ].join("  ");
}

export function relTime(iso: string | Date): string {
  const ms = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return `<t:${Math.floor(ms / 1000)}:R>`;
}
