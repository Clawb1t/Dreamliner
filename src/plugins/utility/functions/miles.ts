import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type MessageActionRowComponentBuilder } from "discord.js";
import { baseEmbed, setEmbedAuthor } from "../../../core/embeds.js";
import { embedReply } from "../../../core/responses.js";
import { getStoreUrl } from "../../../core/docsUrl.js";
import { getCreditBalance } from "../../../core/store/credits.js";
import { getMilesBalance, getMilesPacks } from "../../../core/store/miles.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

/** /miles: your Miles and credits, and the Miles packs as Discord's own purchase buttons. */
export function buildMilesReply(client: Client, userId: string, t: Translator = defaultTranslator) {
  const miles = getMilesBalance(userId);
  const credits = getCreditBalance(userId);
  const packs = getMilesPacks().filter((pack) => pack.skuId);

  const container = baseEmbed();
  setEmbedAuthor(container, t("utility.miles.title", "Your Miles"), client);
  const lines = [
    t("utility.miles.balances", "**{miles} Miles** · **{credits} credits**", {
      miles: miles.toLocaleString("en-GB"),
      credits: credits.toLocaleString("en-GB"),
    }),
    "",
    t(
      "utility.miles.body",
      "Miles buy cosmetics in the Dreamliner Store: profile glows, name fonts and colours, avatar frames, animated backgrounds and more. Credits (from voting) work too, at a lower rate.",
    ),
  ];
  if (packs.length > 0) {
    lines.push("", t("utility.miles.packs", "Get more Miles:"));
    for (const pack of packs) lines.push(`- **${pack.miles.toLocaleString("en-GB")} Miles**, ${pack.price}`);
  } else {
    lines.push("", t("utility.miles.noPacks", "Miles packs aren't on sale right now."));
  }
  container.setDescription(lines.join("\n"));

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (packs.length > 0) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        // Premium buttons carry only the SKU: Discord shows the pack's own name and price.
        packs.slice(0, 5).map((pack) => new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(pack.skuId!)),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t("utility.miles.storeButton", "Open the store")).setURL(getStoreUrl()),
    ),
  );
  return embedReply(container, true, rows);
}
