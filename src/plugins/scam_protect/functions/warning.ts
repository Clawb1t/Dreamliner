import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import { SCAM_PROTECT_STATS_PREFIX } from "../constants.js";

/** Colorless Components v2 warning with catch counter button (no media). */
export function buildScamProtectWarningPayload(caughtCount = 0): MessageCreateOptions {
  const label = `Caught: ${caughtCount}`.slice(0, 80);
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# <:dreamlinerlogo:1536010087468892161> Do not send messages into this channel",
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "This channel is used to catch spam bots. Any messages sent here will result in a softban.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                custom_id: SCAM_PROTECT_STATS_PREFIX,
                label,
              },
            ],
          },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
}
