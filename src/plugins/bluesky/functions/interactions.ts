import { MessageFlags, type ButtonInteraction } from "discord.js";
import { baseEmbed } from "../../../core/embeds.js";
import { containerEdit } from "../../../core/responses.js";
import { translatorFor } from "../../../i18n/index.js";
import { BLUESKY_EMOJIS, parseBlueskyCustomId } from "../constants.js";
import { toggleFollow, toggleLike, toggleRepost } from "./actions.js";
import { actionFeedback } from "./messages.js";
import { disconnect } from "./oauth.js";
import { getDelivery } from "./store.js";

/** Like / Repost on post cards, Follow on profile cards, Disconnect on /bluesky account. */
export async function handleBlueskyButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseBlueskyCustomId(interaction.customId);
  if (!parsed) return false;

  // Every branch talks to Bluesky (or at least the DB), and a token refresh can take a moment.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { t } = await translatorFor(interaction.user.id);
  const userId = interaction.user.id;

  if (parsed.kind === "disconnect") {
    const removed = await disconnect(userId);
    const text = removed
      ? t("bluesky.disconnected", "Disconnected your Bluesky account. Dreamliner can no longer act for you.")
      : t("bluesky.notConnected", "You don't have a Bluesky account connected.");
    await interaction.editReply(containerEdit(baseEmbed().setDescription(`${BLUESKY_EMOJIS.disconnect} ${text}`)));
    return true;
  }

  if (parsed.kind === "follow") {
    const result = await toggleFollow(userId, parsed.did);
    const { container, rows } = actionFeedback(interaction.client, t, "follow", result);
    await interaction.editReply(containerEdit(container, rows));
    return true;
  }

  const delivery = await getDelivery(parsed.deliveryId);
  if (!delivery) {
    await interaction.editReply(
      containerEdit(
        baseEmbed().setDescription(
          `${BLUESKY_EMOJIS.bluesky} ${t("bluesky.cardExpired", "This card is too old to use from Discord. Open the post on Bluesky instead.")}`,
        ),
      ),
    );
    return true;
  }

  const result =
    parsed.kind === "like"
      ? await toggleLike(userId, delivery.postUri, delivery.postCid)
      : await toggleRepost(userId, delivery.postUri, delivery.postCid);
  const { container, rows } = actionFeedback(interaction.client, t, parsed.kind, result);
  await interaction.editReply(containerEdit(container, rows));
  return true;
}
