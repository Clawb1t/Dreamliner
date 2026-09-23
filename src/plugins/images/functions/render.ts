import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  type ComponentInContainerData,
  type TopLevelComponentData,
} from "discord.js";
import type { ImageSource } from "../../../config/schemas/images.js";
import { IMAGE_SOURCE_EMOJIS, IMAGE_SOURCE_LABELS, type ImageResult } from "./sources.js";

/** `dl:img:another:<source>:<userId>`. Only the member who ran /image can reroll their message. */
export const IMAGE_ANOTHER_PREFIX = "dl:img:another:";

const SHUFFLE_EMOJI = "<:icons_shuffle:1544417420112822352>";

export function anotherImageRow(source: ImageSource, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IMAGE_ANOTHER_PREFIX}${source}:${userId}`)
      .setLabel(`Another ${IMAGE_SOURCE_LABELS[source]}`)
      .setEmoji(SHUFFLE_EMOJI)
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Colorless container, same shape as ResultContainer (bold emoji title line, no accent), but with
 * the credit line *below* the image, since ResultContainer always puts its `-#` footer above media.
 * `row` (e.g. the "Another" button) lives inside the container, like every other plugin's buttons.
 */
export function imagePayload(
  source: ImageSource,
  title: string,
  image: ImageResult,
  ephemeral = false,
  row?: ActionRowBuilder<ButtonBuilder>,
) {
  const children: ComponentInContainerData[] = [
    { type: ComponentType.TextDisplay, content: `**${IMAGE_SOURCE_EMOJIS[source]} ${title}**` },
    { type: ComponentType.MediaGallery, items: [{ media: { url: image.url } }] },
    { type: ComponentType.Separator, divider: false, spacing: SeparatorSpacingSize.Small },
    { type: ComponentType.TextDisplay, content: `-# ${image.credit}` },
  ];
  if (row) children.push(row.toJSON());
  const components: TopLevelComponentData[] = [{ type: ComponentType.Container, components: children }];
  return {
    components,
    flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] },
  };
}
