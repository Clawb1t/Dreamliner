import type { Client, Guild, GuildMember, MessageCreateOptions } from "discord.js";
import type { EmbedTone } from "../../../core/embeds.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { SuggestionsConfig, SuggestionDisplayStatus } from "../../../config/schemas/suggestions.js";
import {
  buildSuggestionApproveLog,
  buildSuggestionCommentLog,
  buildSuggestionCreateLog,
  buildSuggestionDenyLog,
} from "../../../core/logging/format.js";
import { sendModerationLog, sendServerLog } from "../../../core/logging/send.js";
import { containerEdit, containerReply, pingComponent } from "../../../core/responses.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
import {
  addComment,
  countComments,
  createSuggestion,
  followSuggestion,
  getSuggestionById,
  getVoteTotals,
  listComments,
  listFollowers,
  type Suggestion,
  type SuggestionComment,
  updateSuggestion,
} from "./store.js";
import {
  buildSuggestionDmContainer,
  buildSuggestionEmbed,
  disabledQueueRow,
  displayStatusLabel,
  queueActionRow,
  resolveTextChannel,
  suggestionJumpRow,
  voteActionRow,
} from "./embeds.js";

async function tryDm(client: Client, userId: string, payload: MessageCreateOptions): Promise<void> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
  } catch {
    // DMs closed
  }
}

/** DMs everyone watching a suggestion (author + followers, minus whoever just caused the
 *  update) a Components V2 container carrying the suggestion's own info, not a plain-text
 *  sentence, so a recipient can tell what was suggested and where without leaving their DMs. */
async function notifyWatchers(
  client: Client,
  guild: Guild,
  suggestion: Suggestion,
  config: SuggestionsConfig,
  title: string,
  tone: EmbedTone,
  extraField?: { label: string; value: string },
  actorId?: string,
): Promise<void> {
  if (!config.notify_author) return;
  const targets = new Set<string>([suggestion.authorId, ...(await listFollowers(suggestion.id))]);
  if (actorId) targets.delete(actorId);
  if (!targets.size) return;

  const container = buildSuggestionDmContainer({ client, guild, suggestion, title, tone, extraField });
  // A denied (or deleted) suggestion has no live post left to jump to.
  const jumpRow = suggestion.status === "denied" ? null : suggestionJumpRow(guild, suggestion);
  const payload = containerReply(container, false, jumpRow ? [jumpRow] : undefined);
  await Promise.all([...targets].map((id) => tryDm(client, id, payload)));
}

/** Every re-render of a suggestion post must carry its comments, or editing it (a vote, a
 *  status mark, an approval) would silently drop the "Comment #N" fields. */
async function loadCommentContext(
  suggestionId: number,
): Promise<{ comments: Awaited<ReturnType<typeof listComments>>; commentCount: number }> {
  const [comments, commentCount] = await Promise.all([listComments(suggestionId, 100), countComments(suggestionId)]);
  return { comments, commentCount };
}

async function maybeGrantRole(guild: Guild, userId: string, roleId?: string): Promise<void> {
  if (!roleId) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.roles.cache.has(roleId)) return;
  await member.roles.add(roleId).catch(() => null);
}

export async function submitSuggestion(options: {
  client: Client;
  guild: Guild;
  author: GuildMember;
  guildConfig: GuildConfig;
  config: SuggestionsConfig;
  content: string;
  attachmentUrl?: string | null;
  anonymous: boolean;
  t?: Translator;
}): Promise<{ suggestion: Suggestion; error?: string }> {
  const { client, guild, author, guildConfig, config, content, attachmentUrl, anonymous, t = defaultTranslator } = options;

  const status = config.mode === "autoapprove" ? "approved" : "awaiting_review";
  let suggestion = await createSuggestion({
    guildId: guild.id,
    authorId: author.id,
    content,
    attachmentUrl,
    anonymous: anonymous && config.anonymous,
    status,
  });

  await sendServerLog(
    client,
    guildConfig,
    buildSuggestionCreateLog({
      suggestionNumber: suggestion.suggestionNumber,
      author: { id: author.id, name: author.user.username, avatarUrl: author.user.displayAvatarURL({ size: 128 }) },
      content,
    }),
    {
      guildId: guild.id,
      eventType: "suggestion_create",
      actorId: author.id,
    },
  );

  if (status === "awaiting_review") {
    const channel = await resolveTextChannel(client, config.review_channel_id);
    if (!channel) {
      return {
        suggestion,
        error: t("suggestions.error.reviewChannelMissing", "Review channel is not configured or inaccessible."),
      };
    }
    const embed = buildSuggestionEmbed({
      client,
      suggestion,
      config,
      titlePrefix: t("suggestions.titlePrefix.review", "Review"),
      t,
    });
    const payload = containerReply(embed, false, [queueActionRow(suggestion.id, t)]);
    const msg = await channel.send({
      ...payload,
      components: config.review_ping_role
        ? [pingComponent(`<@&${config.review_ping_role}>`), ...payload.components!]
        : payload.components,
      allowedMentions: config.review_ping_role ? { roles: [config.review_ping_role] } : undefined,
    });
    suggestion =
      (await updateSuggestion(suggestion.id, {
        reviewChannelId: channel.id,
        reviewMessageId: msg.id,
      })) ?? suggestion;
    return { suggestion };
  }

  return postToFeed({ client, guild, config, suggestion, t });
}

export async function postToFeed(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestion: Suggestion;
  t?: Translator;
}): Promise<{ suggestion: Suggestion; error?: string }> {
  const { client, guild, config, suggestion: input, t = defaultTranslator } = options;
  const channel = await resolveTextChannel(client, config.suggestions_channel_id);
  if (!channel) {
    return {
      suggestion: input,
      error: t("suggestions.error.suggestionsChannelMissing", "Suggestions channel is not configured or inaccessible."),
    };
  }

  let suggestion =
    (await updateSuggestion(input.id, { status: "approved", staffActorId: input.staffActorId })) ?? input;

  const votes = await getVoteTotals(suggestion.id);
  const embed = buildSuggestionEmbed({ client, suggestion, config, votes, ...(await loadCommentContext(suggestion.id)), t });
  const rows = config.voting_enabled ? [voteActionRow(suggestion.id, config, votes)] : [];
  const feedPayload = containerReply(embed, false, rows);
  const msg = await channel.send({
    ...feedPayload,
    components: config.feed_ping_role
      ? [pingComponent(`<@&${config.feed_ping_role}>`), ...feedPayload.components!]
      : feedPayload.components,
    allowedMentions: config.feed_ping_role ? { roles: [config.feed_ping_role] } : undefined,
  });

  suggestion =
    (await updateSuggestion(suggestion.id, {
      status: "approved",
      feedChannelId: channel.id,
      feedMessageId: msg.id,
    })) ?? suggestion;

  await maybeGrantRole(guild, suggestion.authorId, config.approved_role);
  await notifyWatchers(
    client,
    guild,
    suggestion,
    config,
    t("suggestions.dm.approvedTitle", "Suggestion approved"),
    "success",
    undefined,
    suggestion.staffActorId ?? undefined,
  );

  return { suggestion };
}

export async function refreshFeedMessage(
  client: Client,
  config: SuggestionsConfig,
  suggestion: Suggestion,
  t: Translator = defaultTranslator,
): Promise<void> {
  if (!suggestion.feedChannelId || !suggestion.feedMessageId) return;
  const channel = await resolveTextChannel(client, suggestion.feedChannelId);
  if (!channel) return;
  const msg = await channel.messages.fetch(suggestion.feedMessageId).catch(() => null);
  if (!msg) return;
  const votes = await getVoteTotals(suggestion.id);
  const embed = buildSuggestionEmbed({ client, suggestion, config, votes, ...(await loadCommentContext(suggestion.id)), t });
  const components =
    config.voting_enabled && suggestion.status === "approved"
      ? [voteActionRow(suggestion.id, config, votes)]
      : [];
  await msg.edit(containerEdit(embed, components)).catch(() => null);
}

/** After a new comment is added, re-render whichever of the suggestion's live posted messages
 *  currently exist — the public feed post once approved, and/or the review-queue post while
 *  still awaiting review — so the comment shows up as a new "Comment #N" field immediately
 *  instead of only being visible through `/suggestion info`. Denied/archived posts represent a
 *  closed suggestion and are left as they were. */
async function refreshMessagesWithComments(
  client: Client,
  config: SuggestionsConfig,
  suggestion: Suggestion,
  t: Translator,
): Promise<void> {
  const { comments, commentCount } = await loadCommentContext(suggestion.id);

  if (suggestion.feedChannelId && suggestion.feedMessageId) {
    const channel = await resolveTextChannel(client, suggestion.feedChannelId);
    const msg = channel ? await channel.messages.fetch(suggestion.feedMessageId).catch(() => null) : null;
    if (msg) {
      const votes = await getVoteTotals(suggestion.id);
      const embed = buildSuggestionEmbed({ client, suggestion, config, votes, commentCount, comments, t });
      const components =
        config.voting_enabled && suggestion.status === "approved"
          ? [voteActionRow(suggestion.id, config, votes)]
          : [];
      await msg.edit(containerEdit(embed, components)).catch(() => null);
    }
  }

  if (suggestion.status === "awaiting_review" && suggestion.reviewChannelId && suggestion.reviewMessageId) {
    const channel = await resolveTextChannel(client, suggestion.reviewChannelId);
    const msg = channel ? await channel.messages.fetch(suggestion.reviewMessageId).catch(() => null) : null;
    if (msg) {
      const embed = buildSuggestionEmbed({
        client,
        suggestion,
        config,
        commentCount,
        comments,
        titlePrefix: t("suggestions.titlePrefix.review", "Review"),
        t,
      });
      await msg.edit(containerEdit(embed, [queueActionRow(suggestion.id, t)])).catch(() => null);
    }
  }
}

export async function approveSuggestion(options: {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  t?: Translator;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const { t = defaultTranslator } = options;
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: t("suggestions.error.notFound", "Suggestion not found.") };
  }
  if (suggestion.status !== "awaiting_review") {
    return { suggestion, error: t("suggestions.error.notAwaitingReview", "This suggestion is not awaiting review.") };
  }

  let updated =
    (await updateSuggestion(suggestion.id, { staffActorId: options.staffId, status: "approved" })) ??
    suggestion;

  await sendModerationLog(
    options.client,
    options.guildConfig,
    buildSuggestionApproveLog({
      suggestionNumber: updated.suggestionNumber,
      staff: { id: options.staffId },
      content: updated.content,
    }),
    {
      guildId: options.guild.id,
      eventType: "suggestion_approve",
      actorId: options.staffId,
      targetId: updated.authorId,
    },
  );

  if (suggestion.reviewChannelId && suggestion.reviewMessageId) {
    const channel = await resolveTextChannel(options.client, suggestion.reviewChannelId);
    const msg = channel ? await channel.messages.fetch(suggestion.reviewMessageId).catch(() => null) : null;
    if (msg) {
      const embed = buildSuggestionEmbed({
        client: options.client,
        suggestion: updated,
        config: options.config,
        ...(await loadCommentContext(updated.id)),
        titlePrefix: t("suggestions.status.approved", "Approved"),
        t,
      });
      await msg.edit(containerEdit(embed, [disabledQueueRow(t)])).catch(() => null);
    }
  }

  const posted = await postToFeed({
    client: options.client,
    guild: options.guild,
    config: options.config,
    suggestion: updated,
    t,
  });
  return posted;
}

export async function denySuggestion(options: {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  reason?: string | null;
  silent?: boolean;
  t?: Translator;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const { t = defaultTranslator } = options;
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: t("suggestions.error.notFound", "Suggestion not found.") };
  }
  if (suggestion.status === "denied") {
    return { suggestion, error: t("suggestions.error.alreadyDenied", "This suggestion is already denied.") };
  }

  let updated =
    (await updateSuggestion(suggestion.id, {
      status: "denied",
      staffActorId: options.staffId,
      denialReason: options.reason?.trim() || null,
    })) ?? suggestion;

  await sendModerationLog(
    options.client,
    options.guildConfig,
    buildSuggestionDenyLog({
      suggestionNumber: updated.suggestionNumber,
      staff: { id: options.staffId },
      content: updated.content,
      reason: options.reason,
    }),
    {
      guildId: options.guild.id,
      eventType: "suggestion_deny",
      actorId: options.staffId,
      targetId: updated.authorId,
    },
  );

  if (suggestion.reviewChannelId && suggestion.reviewMessageId) {
    const channel = await resolveTextChannel(options.client, suggestion.reviewChannelId);
    const msg = channel ? await channel.messages.fetch(suggestion.reviewMessageId).catch(() => null) : null;
    if (msg) {
      const embed = buildSuggestionEmbed({
        client: options.client,
        suggestion: updated,
        config: options.config,
        ...(await loadCommentContext(updated.id)),
        titlePrefix: t("suggestions.status.denied", "Denied"),
        t,
      });
      await msg.edit(containerEdit(embed, [disabledQueueRow(t)])).catch(() => null);
    }
  }

  if (suggestion.feedChannelId && suggestion.feedMessageId) {
    const channel = await resolveTextChannel(options.client, suggestion.feedChannelId);
    const msg = channel ? await channel.messages.fetch(suggestion.feedMessageId).catch(() => null) : null;
    if (msg) await msg.delete().catch(() => null);
    updated =
      (await updateSuggestion(updated.id, { feedChannelId: null, feedMessageId: null })) ?? updated;
  }

  if (!options.silent) {
    const deniedChannel = await resolveTextChannel(options.client, options.config.denied_channel_id);
    if (deniedChannel) {
      const embed = buildSuggestionEmbed({
        client: options.client,
        suggestion: updated,
        config: options.config,
        ...(await loadCommentContext(updated.id)),
        titlePrefix: t("suggestions.status.denied", "Denied"),
        t,
      });
      const msg = await deniedChannel.send(containerReply(embed));
      updated =
        (await updateSuggestion(updated.id, {
          deniedChannelId: deniedChannel.id,
          deniedMessageId: msg.id,
        })) ?? updated;
    }

    await notifyWatchers(
      options.client,
      options.guild,
      updated,
      options.config,
      t("suggestions.dm.deniedTitle", "Suggestion denied"),
      "error",
      options.reason?.trim()
        ? { label: t("suggestions.field.reason", "Reason"), value: options.reason.trim() }
        : undefined,
      options.staffId,
    );
  }

  return { suggestion: updated };
}

export async function markSuggestion(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  displayStatus: SuggestionDisplayStatus;
  t?: Translator;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const { t = defaultTranslator } = options;
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: t("suggestions.error.notFound", "Suggestion not found.") };
  }
  if (suggestion.status !== "approved") {
    return { suggestion, error: t("suggestions.error.onlyApprovedCanBeMarked", "Only approved suggestions can be marked.") };
  }

  let updated =
    (await updateSuggestion(suggestion.id, {
      displayStatus: options.displayStatus,
      staffActorId: options.staffId,
      implementedAt: options.displayStatus === "implemented" ? new Date() : suggestion.implementedAt,
    })) ?? suggestion;

  if (options.displayStatus === "implemented") {
    await maybeGrantRole(options.guild, suggestion.authorId, options.config.implemented_role);
    const archive = await resolveTextChannel(options.client, options.config.archive_channel_id);
    if (archive) {
      const votes = await getVoteTotals(updated.id);
      const embed = buildSuggestionEmbed({
        client: options.client,
        suggestion: updated,
        config: options.config,
        votes,
        ...(await loadCommentContext(updated.id)),
        titlePrefix: t("suggestions.titlePrefix.implemented", "Implemented"),
        t,
      });
      const msg = await archive.send(containerReply(embed));
      updated =
        (await updateSuggestion(updated.id, {
          archiveChannelId: archive.id,
          archiveMessageId: msg.id,
        })) ?? updated;
    }
  }

  await refreshFeedMessage(options.client, options.config, updated, t);
  await notifyWatchers(
    options.client,
    options.guild,
    updated,
    options.config,
    t("suggestions.dm.markedTitle", "Suggestion status updated"),
    options.displayStatus === "implemented" ? "success" : "neutral",
    { label: t("suggestions.field.status", "Status"), value: displayStatusLabel(t, options.displayStatus) },
    options.staffId,
  );

  return { suggestion: updated };
}

export async function deleteSuggestion(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  silent?: boolean;
  t?: Translator;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const { t = defaultTranslator } = options;
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: t("suggestions.error.notFound", "Suggestion not found.") };
  }

  for (const [channelId, messageId] of [
    [suggestion.feedChannelId, suggestion.feedMessageId],
    [suggestion.reviewChannelId, suggestion.reviewMessageId],
    [suggestion.deniedChannelId, suggestion.deniedMessageId],
  ] as const) {
    if (!channelId || !messageId) continue;
    const channel = await resolveTextChannel(options.client, channelId);
    const msg = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (msg) await msg.delete().catch(() => null);
  }

  const deletedLabel = t("suggestions.deletedLabel", "Deleted");
  const updated =
    (await updateSuggestion(suggestion.id, {
      status: "denied",
      staffActorId: options.staffId,
      denialReason: options.silent ? deletedLabel : suggestion.denialReason ?? deletedLabel,
      feedChannelId: null,
      feedMessageId: null,
      reviewMessageId: null,
    })) ?? suggestion;

  if (!options.silent) {
    await notifyWatchers(
      options.client,
      options.guild,
      updated,
      options.config,
      t("suggestions.dm.deletedTitle", "Suggestion deleted"),
      "error",
      undefined,
      options.staffId,
    );
  }

  return { suggestion: updated };
}

export async function addSuggestionComment(options: {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  config: SuggestionsConfig;
  suggestionId: number;
  authorId: string;
  authorName: string;
  authorAvatarUrl?: string;
  content: string;
  anonymous: boolean;
  t?: Translator;
}): Promise<{ comment: SuggestionComment; suggestion: Suggestion } | { error: string }> {
  const { t = defaultTranslator } = options;
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { error: t("suggestions.error.notFound", "Suggestion not found.") };
  }

  const content = options.content.trim();
  if (!content) {
    return { error: t("suggestions.error.emptyComment", "Comment can't be empty.") };
  }

  const comment = await addComment({
    suggestionId: suggestion.id,
    authorId: options.authorId,
    content,
    anonymous: options.anonymous && options.config.anonymous,
  });

  await refreshMessagesWithComments(options.client, options.config, suggestion, t);

  await sendServerLog(
    options.client,
    options.guildConfig,
    buildSuggestionCommentLog({
      suggestionNumber: suggestion.suggestionNumber,
      author: { id: options.authorId, name: options.authorName, avatarUrl: options.authorAvatarUrl },
      content,
    }),
    {
      guildId: options.guild.id,
      eventType: "suggestion_comment",
      actorId: options.authorId,
      targetId: suggestion.authorId,
    },
  );

  const commenterLabel = comment.anonymous ? t("suggestions.anonymous", "Anonymous") : `<@${options.authorId}>`;
  await notifyWatchers(
    options.client,
    options.guild,
    suggestion,
    options.config,
    t("suggestions.dm.commentTitle", "New comment on your suggestion"),
    "neutral",
    { label: t("suggestions.field.comment", "Comment"), value: `**${commenterLabel}**\n${content}` },
    options.authorId,
  );

  return { comment, suggestion };
}

export async function autoFollowOnUpvote(
  config: SuggestionsConfig,
  suggestionId: number,
  userId: string,
): Promise<void> {
  if (!config.follow_on_upvote) return;
  await followSuggestion(suggestionId, userId);
}
