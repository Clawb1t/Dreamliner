import { ButtonStyle, ComponentType, MessageFlags, type MessageCreateOptions } from "discord.js";
import { DREAMLINER_ACCENT } from "../../../core/embeds.js";
import { VOTE_URL } from "../../../core/docsUrl.js";

/** Components v2 container for /vote — Dreamliner's accent color, a short note, and a
 * link button to the bot's top.gg page. */
export function buildVotePayload(): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        accentColor: DREAMLINER_ACCENT,
        components: [
          {
            type: ComponentType.TextDisplay,
            content:
              "<:dreamlinerlogo:1536010087468892161> If Dreamliner has been useful for your server, we'd really appreciate your vote. It's free, and it genuinely helps us reach more communities. Thank you for the support.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                label: "Vote for Dreamliner",
                url: VOTE_URL,
              },
            ],
          },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
}
