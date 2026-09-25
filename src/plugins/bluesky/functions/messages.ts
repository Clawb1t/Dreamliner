/** Reply containers shared by buttons, reactions and commands, so every surface words things the same way. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";
import { baseEmbed, setEmbedAuthor, type ResultContainer } from "../../../core/embeds.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { getAccountConnectionsUrl } from "../../../core/docsUrl.js";
import type { Translator } from "../../../i18n/index.js";
import { BLUESKY_EMOJIS } from "../constants.js";
import type { BlueskyActionKind } from "./accounts.js";
import type { ActionFailure, ActionResult } from "./actions.js";

export type ReplyParts = { container: ResultContainer; rows: ActionRowBuilder<ButtonBuilder>[] };

export function connectButtonRow(t: Translator): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(t("bluesky.connectButton", "Connect Bluesky"))
      .setEmoji(parseComponentEmoji(BLUESKY_EMOJIS.connect) ?? "🔗")
      .setStyle(ButtonStyle.Link)
      .setURL(getAccountConnectionsUrl()),
  );
}

/** "Connect your Bluesky account" prompt, shown when a member without a link tries an action. */
export function connectPrompt(client: Client, t: Translator, expired = false): ReplyParts {
  const container = setEmbedAuthor(
    baseEmbed(),
    expired
      ? t("bluesky.reconnectTitle", "Reconnect your Bluesky account")
      : t("bluesky.connectTitle", "Connect your Bluesky account"),
    client,
    { emoji: BLUESKY_EMOJIS.bluesky, tone: "neutral" },
  ).setDescription(
    expired
      ? t(
          "bluesky.reconnectBody",
          "Your Bluesky session ended, so Dreamliner can't act for you right now. Connect again on your account page. It only takes a moment.",
        )
      : t(
          "bluesky.connectBody",
          "Connect your Bluesky account once and you can like, repost and follow straight from Discord. You sign in on Bluesky itself, no app password needed.",
        ),
  );
  return { container, rows: [connectButtonRow(t)] };
}

const FAILURE_TEXT: Record<Exclude<ActionFailure, "not_connected" | "expired">, [string, string]> = {
  not_configured: ["bluesky.notConfigured", "Bluesky accounts aren't set up on this bot yet."],
  rate_limited: ["bluesky.rateLimited", "That's a lot at once. Give it a minute and try again."],
  unavailable: ["bluesky.unavailable", "Couldn't reach your Bluesky server. Try again shortly."],
  failed: ["bluesky.failed", "Bluesky didn't accept that right now. Try again shortly."],
};

const SUCCESS_TEXT: Record<BlueskyActionKind, { on: [string, string]; off: [string, string]; emoji: string }> = {
  like: {
    on: ["bluesky.likedOn", "Liked on Bluesky as **@{handle}**."],
    off: ["bluesky.likedOff", "Removed your like."],
    emoji: BLUESKY_EMOJIS.like,
  },
  repost: {
    on: ["bluesky.repostedOn", "Reposted on Bluesky as **@{handle}**."],
    off: ["bluesky.repostedOff", "Removed your repost."],
    emoji: BLUESKY_EMOJIS.repost,
  },
  follow: {
    on: ["bluesky.followedOn", "Following them on Bluesky as **@{handle}**."],
    off: ["bluesky.followedOff", "Unfollowed them on Bluesky."],
    emoji: BLUESKY_EMOJIS.people,
  },
};

/** The ephemeral reply for a like/repost/follow button press. */
export function actionFeedback(client: Client, t: Translator, kind: BlueskyActionKind, result: ActionResult): ReplyParts {
  if (!result.ok) {
    if (result.reason === "not_connected" || result.reason === "expired") {
      return connectPrompt(client, t, result.reason === "expired");
    }
    const [key, fallback] = FAILURE_TEXT[result.reason];
    return { container: baseEmbed().setDescription(`${BLUESKY_EMOJIS.bluesky} ${t(key, fallback)}`), rows: [] };
  }
  const copy = SUCCESS_TEXT[kind];
  const [key, fallback] = copy[result.state];
  return {
    container: baseEmbed().setDescription(`${copy.emoji} ${t(key, fallback, { handle: result.handle })}`),
    rows: [],
  };
}
