import { ButtonStyle, ComponentType, MessageFlags, type MessageCreateOptions } from "discord.js";
import { DREAMLINER_ACCENT } from "../../../core/embeds.js";
import { VOTE_URL, getAccountStoreUrl } from "../../../core/docsUrl.js";
import { STORE_PRICING } from "../../../core/store/pricing.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

/** Components v2 container for /vote: Dreamliner's accent color, a short note about the store
 * credits a vote earns, a link button to the bot's top.gg page and one to the member's credits. */
export function buildVotePayload(t: Translator = defaultTranslator): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        accentColor: DREAMLINER_ACCENT,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `<:dreamlinerlogo:1536010087468892161> ${t(
              "utility.vote.bodyCredits",
              "If Dreamliner has been useful for your server, we'd really appreciate your vote. Every vote earns you **{credits} store credits** to spend on Dreamliner One for a server you manage.",
              { credits: STORE_PRICING.creditsPerVote },
            )}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                label: t("utility.vote.buttonLabel", "Vote for Dreamliner"),
                url: VOTE_URL,
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                label: t("utility.vote.creditsButtonLabel", "Your credits"),
                url: getAccountStoreUrl(),
              },
            ],
          },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
}
