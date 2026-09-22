import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { baseEmbed, embedField, setEmbedAuthor, trimLines, type EmbedTone, type ResultContainer } from "../../../core/embeds.js";
import type { SuggestionsConfig } from "../../../config/schemas/suggestions.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
import {
  DISPLAY_STATUS_LABELS,
  suggestQueueApproveId,
  suggestQueueDenyId,
  suggestVoteId,
} from "../constants.js";
import type { Suggestion, SuggestionComment, VoteTotals } from "./store.js";

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

/** How many "Comment #N" fields the live posted embed carries at once — older comments still
 *  exist in the DB (and via `/suggestion info`) but drop off the live message to keep it from
 *  growing without bound as a popular suggestion accumulates comments. */
const MAX_LIVE_COMMENT_FIELDS = 15;
/** Per-comment body length in the live embed, well short of the 1000-char `/suggestion comment`
 *  input cap so several comment fields plus the rest of the embed stay comfortably inside the
 *  container's overall text budget. */
const LIVE_COMMENT_BODY_LIMIT = 400;

/** Renders a comment as a Discord blockquote — one `>` per line, so a multi-line comment quotes
 *  correctly instead of only the first line. */
function quoteCommentBody(content: string): string {
  const trimmed = trimLines(content);
  const truncated = trimmed.length > LIVE_COMMENT_BODY_LIMIT ? `${trimmed.slice(0, LIVE_COMMENT_BODY_LIMIT)}…` : trimmed;
  return truncated
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function buildSuggestionEmbed(options: {
  client: Client;
  suggestion: Suggestion;
  config: SuggestionsConfig;
  votes?: VoteTotals;
  titlePrefix?: string;
  commentCount?: number;
  /** Comments to render as individual "Comment #N" fields on the live posted embed (oldest
   *  first) — distinct from `commentCount`, which is just the summary number shown above them. */
  comments?: SuggestionComment[];
  t?: Translator;
}) {
  const { client, suggestion, config, votes, titlePrefix, commentCount, comments, t = defaultTranslator } = options;
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

  if (commentCount) {
    embed.addFields(
      embedField(t("suggestions.field.comments", "Comments"), String(commentCount), true),
    );
  }

  if (comments?.length) {
    const shown = comments.slice(-MAX_LIVE_COMMENT_FIELDS);
    const offset = comments.length - shown.length;
    shown.forEach((comment, i) => {
      const number = offset + i + 1;
      const author = comment.anonymous ? t("suggestions.anonymous", "Anonymous") : `<@${comment.authorId}>`;
      embed.addFields(
        embedField(
          t("suggestions.field.commentNumber", "Comment #{n}", { n: number }),
          `${author}\n${quoteCommentBody(comment.content)}`,
        ),
      );
    });
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

/** A link button to the suggestion's public post (feed message if it has one, otherwise the
 *  review queue message), for DM notifications where there's no channel to jump from directly.
 *  Returns undefined when neither message has been posted yet (nothing to link to). */
export function suggestionJumpRow(
  guild: Guild,
  suggestion: Suggestion,
  t: Translator = defaultTranslator,
): ActionRowBuilder<ButtonBuilder> | undefined {
  const channelId = suggestion.feedChannelId ?? suggestion.reviewChannelId;
  const messageId = suggestion.feedMessageId ?? suggestion.reviewMessageId;
  if (!channelId || !messageId) return undefined;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(t("suggestions.viewSuggestion", "View suggestion"))
      .setURL(`https://discord.com/channels/${guild.id}/${channelId}/${messageId}`),
  );
}

/**
 * The container sent for a suggestion DM notification (approved, denied, marked, deleted,
 * commented on). Replaces the old plain-text `user.send(string)` with the same Components V2
 * container style every other suggestion message already uses, carrying real suggestion info
 * (content, server, status) instead of one flattened sentence.
 */
export function buildSuggestionDmContainer(options: {
  client: Client;
  guild: Guild;
  suggestion: Suggestion;
  title: string;
  tone: EmbedTone;
  extraField?: { label: string; value: string };
  t?: Translator;
}): ResultContainer {
  const { client, guild, suggestion, title, tone, extraField, t = defaultTranslator } = options;
  const container = setEmbedAuthor(baseEmbed(), title, client, { tone })
    .setDescription(trimLines(suggestion.content).slice(0, 500))
    .addFields(
      embedField(t("suggestions.field.server", "Server"), guild.name, true),
      embedField(t("suggestions.field.suggestion", "Suggestion"), `#${suggestion.suggestionNumber}`, true),
    );
  if (extraField) {
    container.addFields(embedField(extraField.label, extraField.value));
  }
  return container;
}

/** Formats a suggestion's comments for display under `/suggestion info`. Empty string when there are none. */
export function formatCommentsList(comments: SuggestionComment[], t: Translator = defaultTranslator): string {
  if (!comments.length) return "";
  return comments
    .map((c) => {
      const author = c.anonymous ? t("suggestions.anonymous", "Anonymous") : `<@${c.authorId}>`;
      const when = `<t:${Math.floor(c.createdAt.getTime() / 1000)}:R>`;
      return `${author} ${when}\n${trimLines(c.content)}`;
    })
    .join("\n\n");
}
