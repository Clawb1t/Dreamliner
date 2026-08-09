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
import {
  DISPLAY_STATUS_LABELS,
  suggestQueueApproveId,
  suggestQueueDenyId,
  suggestVoteId,
} from "../constants.js";
import type { Suggestion, VoteTotals } from "./store.js";

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
  const custom = /^<a?:(\w+):(\d+)>$/.exec(emoji.trim());
  if (custom) {
    return button.setEmoji({ name: custom[1], id: custom[2] });
  }
  return button.setEmoji(emoji.trim());
}

export function buildSuggestionEmbed(options: {
  client: Client;
  suggestion: Suggestion;
  config: SuggestionsConfig;
  votes?: VoteTotals;
  titlePrefix?: string;
}) {
  const { client, suggestion, config, votes, titlePrefix } = options;
  const authorLabel = suggestion.anonymous ? "Anonymous" : `<@${suggestion.authorId}>`;
  const statusLabel =
    suggestion.status === "awaiting_review"
      ? "Awaiting review"
      : suggestion.status === "denied"
        ? "Denied"
        : DISPLAY_STATUS_LABELS[suggestion.displayStatus] ?? "Approved";

  let color: number | undefined;
  if (
    suggestion.status === "approved" &&
    config.color_change_threshold > 0 &&
    votes &&
    votes.net >= config.color_change_threshold
  ) {
    color = config.color_change_color;
  } else if (suggestion.status === "denied") {
    color = 0xed4245;
  } else if (suggestion.status === "awaiting_review") {
    color = 0xfee75c;
  } else if (suggestion.displayStatus === "implemented") {
    color = 0x57f287;
  }

  const embedBase = baseEmbed();
  if (color != null) embedBase.setColor(color);

  const embed = setEmbedAuthor(
    embedBase,
    `${titlePrefix ?? "Suggestion"} #${suggestion.suggestionNumber}`,
    client,
    { tone: suggestion.status === "denied" ? "error" : "neutral" },
  )
    .setDescription(suggestion.content)
    .addFields(
      embedField("Author", authorLabel, true),
      embedField("Status", statusLabel, true),
      embedField("Submitted", `<t:${Math.floor(suggestion.createdAt.getTime() / 1000)}:R>`, true),
    );

  if (suggestion.attachmentUrl) {
    embed.setImage(suggestion.attachmentUrl);
  }

  if (suggestion.denialReason) {
    embed.addFields(embedField("Reason", suggestion.denialReason));
  }

  if (suggestion.anonymous) {
    embed.setFooter({ text: `ID ${suggestion.id} · Anonymous submission` });
  } else {
    embed.setFooter({ text: `ID ${suggestion.id}` });
  }

  return embed;
}

export function queueActionRow(suggestionId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(suggestQueueApproveId(suggestionId))
      .setLabel("Approve")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(suggestQueueDenyId(suggestionId))
      .setLabel("Deny")
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

export function disabledQueueRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("dl:suggest:done:a")
      .setLabel("Approved")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("dl:suggest:done:d")
      .setLabel("Denied")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}
