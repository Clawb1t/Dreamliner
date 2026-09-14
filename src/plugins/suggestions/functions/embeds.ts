import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import { baseEmbed, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import type { SuggestionsConfig } from "../../../config/schemas/suggestions.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
import {
  DISPLAY_STATUS_LABELS,
  suggestQueueApproveId,
  suggestQueueDenyId,
  suggestVoteId,
} from "../constants.js";
import type { Suggestion, VoteTotals } from "./store.js";

/** Translated display-status label — falls back to the English label from constants.ts. */
export function displayStatusLabel(t: Translator, value: string): string {
  return t(`suggestions.displayStatus.${value}`, DISPLAY_STATUS_LABELS[value] ?? value);
}

export async function resolveTextChannel(
  client: Client,
  channelId: string | undefined | null,
): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  const channel =
    client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased() || channel.isDMBased()) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return null;
  }
  return channel;
}

function applyButtonEmoji(button: ButtonBuilder, emoji?: string) {
  if (!emoji?.trim()) return button;
  const parsed = parseComponentEmoji(emoji);
  if (!parsed) return button;
  return button.setEmoji(parsed);
}

export function buildSuggestionEmbed(options: {
  client: Client;
  suggestion: Suggestion;
  config: SuggestionsConfig;
  votes?: VoteTotals;
  titlePrefix?: string;
  t?: Translator;
}) {
  const { client, suggestion, config, votes, titlePrefix, t = defaultTranslator } = options;
  const authorLabel = suggestion.anonymous ? t("suggestions.anonymous", "Anonymous") : `<@${suggestion.authorId}>`;
  const statusLabel =
    suggestion.status === "awaiting_review"
      ? t("suggestions.status.awaitingReview", "Awaiting review")
      : suggestion.status === "denied"
        ? t("suggestions.status.denied", "Denied")
        : displayStatusLabel(t, suggestion.displayStatus);

  let tone: "success" | "warning" | "error" | "neutral" = "neutral";
  if (suggestion.status === "denied") {
    tone = "error";
  } else if (suggestion.status === "awaiting_review") {
    tone = "warning";
  } else if (suggestion.displayStatus === "implemented") {
    tone = "success";
  } else if (
    suggestion.status === "approved" &&
    config.color_change_threshold > 0 &&
    votes &&
    votes.net >= config.color_change_threshold
  ) {
    tone = "success";
  }

  const embed = setEmbedAuthor(
    baseEmbed(),
    `${titlePrefix ?? t("suggestions.embedTitle", "Suggestion")} #${suggestion.suggestionNumber}`,
    client,
    { tone },
  )
    .setDescription(suggestion.content)
    .addFields(
      embedField(t("suggestions.field.author", "Author"), authorLabel, true),
      embedField(t("suggestions.field.status", "Status"), statusLabel, true),
      embedField(
        t("suggestions.field.submitted", "Submitted"),
        `<t:${Math.floor(suggestion.createdAt.getTime() / 1000)}:R>`,
        true,
      ),
    );

  if (suggestion.attachmentUrl) {
    embed.setImage(suggestion.attachmentUrl);
  }

  if (suggestion.denialReason) {
    embed.addFields(embedField(t("suggestions.field.reason", "Reason"), suggestion.denialReason));
  }

  if (suggestion.anonymous) {
    embed.setFooter({
      text: t("suggestions.footer.anonymous", "ID {id} · Anonymous submission", { id: suggestion.id }),
    });
  } else {
    embed.setFooter({ text: t("suggestions.footer.id", "ID {id}", { id: suggestion.id }) });
  }

  return embed;
}

export function queueActionRow(suggestionId: number, t: Translator = defaultTranslator): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(suggestQueueApproveId(suggestionId))
      .setLabel(t("suggestions.button.approve", "Approve"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(suggestQueueDenyId(suggestionId))
      .setLabel(t("suggestions.button.deny", "Deny"))
      .setStyle(ButtonStyle.Secondary),
  );
}

export function voteActionRow(
  suggestionId: number,
  config: SuggestionsConfig,
  votes?: VoteTotals,
): ActionRowBuilder<ButtonBuilder> {
  const upLabel = config.show_vote_count && votes ? `${config.upvote_label} (${votes.up})` : config.upvote_label;
  const downLabel =
    config.show_vote_count && votes ? `${config.downvote_label} (${votes.down})` : config.downvote_label;
  const midLabel =
    config.show_vote_count && votes ? `${config.midvote_label} (${votes.mid})` : config.midvote_label;

  const buttons = [
    applyButtonEmoji(
      new ButtonBuilder()
        .setCustomId(suggestVoteId(suggestionId, "up"))
        .setLabel(upLabel.slice(0, 80))
        .setStyle(ButtonStyle.Secondary),
      config.upvote_emoji,
    ),
  ];

  if (config.mid_vote_enabled) {
    buttons.push(
      applyButtonEmoji(
        new ButtonBuilder()
          .setCustomId(suggestVoteId(suggestionId, "mid"))
          .setLabel(midLabel.slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
        config.midvote_emoji,
      ),
    );
  }

  buttons.push(
    applyButtonEmoji(
      new ButtonBuilder()
        .setCustomId(suggestVoteId(suggestionId, "down"))
        .setLabel(downLabel.slice(0, 80))
        .setStyle(ButtonStyle.Secondary),
      config.downvote_emoji,
    ),
  );

  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

export function disabledQueueRow(t: Translator = defaultTranslator): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("dl:suggest:done:a")
      .setLabel(t("suggestions.status.approved", "Approved"))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("dl:suggest:done:d")
      .setLabel(t("suggestions.status.denied", "Denied"))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}
