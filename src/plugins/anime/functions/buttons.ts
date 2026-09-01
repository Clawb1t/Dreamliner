import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import { downloadNekoImage, nekoRefToUrl } from "./nekosBest.js";
import { formatSavedNekoFooter } from "./format.js";
import { listSavedNekos, saveNeko, unsaveNeko, type SavedNeko } from "./store.js";

export const ANIME_SAVE_PREFIX = "anime:save:";
export const ANIME_SAVED_NAV_PREFIX = "anime:savednav:";
/** Disabled, link-less stand-in for the artist button when a neko has a name but no href. */
const ANIME_ARTIST_LABEL_PREFIX = "anime:artist:";
const NEKOS_BEST_URL = "https://nekos.best";

function nekosBestButton(): ButtonBuilder {
  return new ButtonBuilder().setLabel("Nekos.best").setStyle(ButtonStyle.Link).setURL(NEKOS_BEST_URL);
}

/** Credit button for the artist: a real link when there's an href to send members to, otherwise
 *  an inert labeled button so the name isn't lost. `null` when there's no credit at all. */
function artistButton(artistName: string | null, artistHref: string | null): ButtonBuilder | null {
  const href = artistHref?.trim();
  const name = artistName?.trim();
  if (href) {
    return new ButtonBuilder().setLabel((name || "Artist").slice(0, 80)).setStyle(ButtonStyle.Link).setURL(href);
  }
  if (name) {
    return new ButtonBuilder()
      .setCustomId(`${ANIME_ARTIST_LABEL_PREFIX}0`)
      .setLabel(name.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
  }
  return null;
}

/** Recovers the artist credit straight from a neko message's own button row instead of parsing
 *  text — the artist button (if any) is whichever credit button isn't the fixed Nekos.best link. */
function extractArtistFromMessage(message: Message): { artistName: string | null; artistHref: string | null } {
  const row = message.components[0];
  if (!row || row.type !== ComponentType.ActionRow) return { artistName: null, artistHref: null };
  for (const component of row.components) {
    if (component.type !== ComponentType.Button) continue;
    if (component.style === ButtonStyle.Link) {
      if (component.url === NEKOS_BEST_URL) continue;
      return { artistName: component.label ?? null, artistHref: component.url ?? null };
    }
    if (component.customId?.startsWith(ANIME_ARTIST_LABEL_PREFIX)) {
      return { artistName: component.label ?? null, artistHref: null };
    }
  }
  return { artistName: null, artistHref: null };
}

/** Row on a fresh `/anime neko` reply: a blurple Save button, the artist credit, and a link to
 *  Nekos.best. */
export function buildNekoSaveRow(ref: string, artistName: string | null, artistHref: string | null): ActionRowBuilder<ButtonBuilder> {
  const buttons = [new ButtonBuilder().setCustomId(`${ANIME_SAVE_PREFIX}${ref}`).setLabel("Save").setStyle(ButtonStyle.Primary)];
  const artist = artistButton(artistName, artistHref);
  if (artist) buttons.push(artist);
  buttons.push(nekosBestButton());
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

export function buildSavedNavRow(
  index: number,
  total: number,
  artistName: string | null,
  artistHref: string | null,
): ActionRowBuilder<ButtonBuilder> {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`${ANIME_SAVED_NAV_PREFIX}left:${index}`)
      .setLabel("Left")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId(`${ANIME_SAVED_NAV_PREFIX}unsave:${index}`)
      .setLabel("Unsave")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${ANIME_SAVED_NAV_PREFIX}right:${index}`)
      .setLabel("Right")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= total - 1),
  ];
  const artist = artistButton(artistName, artistHref);
  if (artist) buttons.push(artist);
  buttons.push(nekosBestButton());
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

async function buildSavedViewPayload(neko: SavedNeko, index: number, total: number) {
  const image = await downloadNekoImage(neko.imageUrl).catch(() => null);
  return {
    content: formatSavedNekoFooter(index, total),
    files: image ? [new AttachmentBuilder(image.buffer, { name: image.filename })] : [],
    attachments: [],
    components: [buildSavedNavRow(index, total, neko.artistName, neko.artistHref)],
  };
}

/** "Save" button on a fresh `/anime neko` reply — saves it to the clicker's own collection. */
export async function handleAnimeSaveButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(ANIME_SAVE_PREFIX)) return false;

  const ref = interaction.customId.slice(ANIME_SAVE_PREFIX.length);
  const { artistName, artistHref } = extractArtistFromMessage(interaction.message);
  const result = await saveNeko(interaction.user.id, {
    imageUrl: nekoRefToUrl(ref),
    artistName,
    artistHref,
  });

  await interaction
    .reply({
      content: result.ok
        ? "<:icons_heart:1544417554225700904> Saved! Use `/anime saved` to browse your nekos."
        : result.error,
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => null);
  return true;
}

/** Left/Unsave/Right on an `/anime saved` reply — always re-reads the clicker's list fresh. */
export async function handleAnimeSavedNavButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(ANIME_SAVED_NAV_PREFIX)) return false;

  const rest = interaction.customId.slice(ANIME_SAVED_NAV_PREFIX.length);
  const [action, indexRaw] = rest.split(":");
  const currentIndex = Number(indexRaw);
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return true;

  if (action === "unsave") {
    const before = await listSavedNekos(interaction.user.id);
    const target = before[currentIndex];
    if (target) await unsaveNeko(interaction.user.id, target.id);
  }

  const saved = await listSavedNekos(interaction.user.id);
  if (saved.length === 0) {
    await interaction
      .update({ content: "You have no saved nekos left.", files: [], attachments: [], components: [] })
      .catch(() => null);
    return true;
  }

  let nextIndex = currentIndex;
  if (action === "left") nextIndex = currentIndex - 1;
  else if (action === "right") nextIndex = currentIndex + 1;
  nextIndex = Math.min(Math.max(nextIndex, 0), saved.length - 1);

  const payload = await buildSavedViewPayload(saved[nextIndex]!, nextIndex, saved.length);
  await interaction.update(payload).catch(() => null);
  return true;
}
