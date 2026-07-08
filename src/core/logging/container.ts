import { ComponentType, MessageFlags, SeparatorSpacingSize } from "discord.js";
import type { ComponentInContainerData, MessageCreateOptions } from "discord.js";
import { trimLines } from "../embeds.js";
import type { LogCard } from "./types.js";

const MAX_TEXT = 4000;

function informationBlock(lines: string[]): string {
  return trimLines(`**Information**\n${lines.join("\n")}`).slice(0, MAX_TEXT);
}

function titleLine(title: string): string {
  return `**${title}**`.slice(0, MAX_TEXT);
}

export function buildLogPayload(card: LogCard): MessageCreateOptions {
  const containerChildren: ComponentInContainerData[] = [];
  const info = informationBlock(card.information);

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
    containerChildren.push({
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small,
    });
    containerChildren.push({
      type: ComponentType.TextDisplay,
      content: card.extra.slice(0, MAX_TEXT),
    });
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: containerChildren,
      },
    ],
    allowedMentions: { parse: [] },
  };
}
