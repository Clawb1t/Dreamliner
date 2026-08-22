import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
} from "discord.js";
import type { ComponentInContainerData, MessageCreateOptions, TopLevelComponentData } from "discord.js";
import { trimLines } from "../embeds.js";
import type { LogButton, LogCard, LogFile } from "./types.js";

const MAX_TEXT = 4000;
/** Leave room for the title/info text itself before we fall back to a file. */
const OVERFLOW_NOTE = "\n\n⚠️ Full details attached as a file below (too long for a message).";

function informationBlock(lines: string[]): string {
  return trimLines(`**Information**\n${lines.join("\n")}`);
}

function titleLine(title: string): string {
  return `**${title}**`.slice(0, MAX_TEXT);
}

/**
 * Keeps `text` under Discord's per-component text limit. If it doesn't fit, the full text is
 * spun off into a text file (named `fallbackFileName`) and a short truncated preview plus a
 * pointer note is returned instead of silently cutting content off.
 */
function fitOrFile(
  text: string,
  fallbackFileName: string,
  files: LogFile[],
): string {
  if (text.length <= MAX_TEXT) return text;
  files.push({ name: fallbackFileName, content: text });
  const budget = MAX_TEXT - OVERFLOW_NOTE.length;
  return `${text.slice(0, Math.max(0, budget))}${OVERFLOW_NOTE}`;
}

function buttonStyle(style: LogButton["style"]): ButtonStyle {
  switch (style) {
    case "primary":
    case "secondary":
    case "success":
    case "danger":
      // Only link-style buttons are wired up today (no interaction handler exists for
      // custom-id buttons on log messages), so any non-link style still renders as a link.
      return ButtonStyle.Link;
    default:
      return ButtonStyle.Link;
  }
}

function buildButtonRow(buttons: LogButton[]): ActionRowBuilder<ButtonBuilder> | null {
  const trimmed = buttons.slice(0, 5);
  if (!trimmed.length) return null;
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const button of trimmed) {
    const b = new ButtonBuilder()
      .setLabel(button.label.slice(0, 80))
      .setStyle(buttonStyle(button.style))
      .setURL(button.url);
    if (button.emoji) b.setEmoji(button.emoji);
    row.addComponents(b);
  }
  return row;
}

export function buildLogPayload(card: LogCard): MessageCreateOptions {
  const files: LogFile[] = [...(card.files ?? [])];
  const containerChildren: ComponentInContainerData[] = [];

  const info = fitOrFile(informationBlock(card.information), "log-details.txt", files);

  if (card.avatarUrl) {
    containerChildren.push({
      type: ComponentType.Section,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: titleLine(card.title),
        },
        {
          type: ComponentType.TextDisplay,
          content: info,
        },
      ],
      accessory: {
        type: ComponentType.Thumbnail,
        media: { url: card.avatarUrl },
      },
    });
  } else {
    containerChildren.push({
      type: ComponentType.TextDisplay,
      content: titleLine(card.title),
    });
    containerChildren.push({
      type: ComponentType.TextDisplay,
      content: info,
    });
  }

  if (card.extra) {
    const extra = fitOrFile(card.extra, "log-extra.txt", files);
    containerChildren.push({
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small,
    });
    containerChildren.push({
      type: ComponentType.TextDisplay,
      content: extra,
    });
  }

  const components: TopLevelComponentData[] = [
    {
      type: ComponentType.Container,
      components: containerChildren,
    },
  ];

  const buttonRow = card.buttons ? buildButtonRow(card.buttons) : null;
  if (buttonRow) components.push(buttonRow.toJSON());

  const attachments = files
    .slice(0, 8)
    .map((file) => new AttachmentBuilder(Buffer.from(file.content, "utf-8"), { name: file.name }));

  return {
    flags: MessageFlags.IsComponentsV2,
    components,
    files: attachments,
    allowedMentions: { parse: [] },
  };
}
