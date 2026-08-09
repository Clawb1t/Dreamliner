import type { Client, Guild, GuildMember } from "discord.js";
import type { SuggestionsConfig, SuggestionDisplayStatus } from "../../../config/schemas/suggestions.js";
import {
  addComment,
  createSuggestion,
  followSuggestion,
  getSuggestionById,
  getVoteTotals,
  listComments,
  listFollowers,
  type Suggestion,
  updateSuggestion,
} from "./store.js";
import {
  buildSuggestionEmbed,
  disabledQueueRow,
  queueActionRow,
  resolveTextChannel,
  voteActionRow,
} from "./embeds.js";

async function tryDm(client: Client, userId: string, content: string): Promise<void> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(content);
  } catch {
    // DMs closed
  }
}

async function notifyWatchers(
  client: Client,
  suggestion: Suggestion,
  config: SuggestionsConfig,
  message: string,
  actorId?: string,
): Promise<void> {
  if (!config.notify_author) return;
  const targets = new Set<string>([suggestion.authorId, ...(await listFollowers(suggestion.id))]);
  if (actorId) targets.delete(actorId);
  await Promise.all([...targets].map((id) => tryDm(client, id, message)));
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
  config: SuggestionsConfig;
  content: string;
  attachmentUrl?: string | null;
  anonymous: boolean;
}): Promise<{ suggestion: Suggestion; error?: string }> {
  const { client, guild, author, config, content, attachmentUrl, anonymous } = options;

  const status = config.mode === "autoapprove" ? "approved" : "awaiting_review";
  let suggestion = await createSuggestion({
    guildId: guild.id,
    authorId: author.id,
    content,
    attachmentUrl,
    anonymous: anonymous && config.anonymous,
    status,
  });

  if (status === "awaiting_review") {
    const channel = await resolveTextChannel(client, config.review_channel_id);
    if (!channel) {
      return { suggestion, error: "Review channel is not configured or inaccessible." };
    }
    const embed = buildSuggestionEmbed({
      client,
      suggestion,
      config,
      titlePrefix: "Review",
    });
    const contentPing = config.review_ping_role ? `<@&${config.review_ping_role}>` : undefined;
    const msg = await channel.send({
      content: contentPing,
      embeds: [embed],
      components: [queueActionRow(suggestion.id)],
      allowedMentions: config.review_ping_role ? { roles: [config.review_ping_role] } : undefined,
    });
    suggestion =
      (await updateSuggestion(suggestion.id, {
        reviewChannelId: channel.id,
        reviewMessageId: msg.id,
      })) ?? suggestion;
    return { suggestion };
  }

  return postToFeed({ client, guild, config, suggestion });
}

export async function postToFeed(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestion: Suggestion;
}): Promise<{ suggestion: Suggestion; error?: string }> {
  const { client, guild, config, suggestion: input } = options;
  const channel = await resolveTextChannel(client, config.suggestions_channel_id);
  if (!channel) {
    return { suggestion: input, error: "Suggestions channel is not configured or inaccessible." };
  }

  let suggestion =
    (await updateSuggestion(input.id, { status: "approved", staffActorId: input.staffActorId })) ?? input;

  const votes = await getVoteTotals(suggestion.id);
  const comments = await listComments(suggestion.id);
  const embed = buildSuggestionEmbed({ client, suggestion, config, votes, comments });
  const components = config.voting_enabled ? [voteActionRow(suggestion.id, config, votes)] : [];
  const contentPing = config.feed_ping_role ? `<@&${config.feed_ping_role}>` : undefined;
  const msg = await channel.send({
    content: contentPing,
    embeds: [embed],
    components,
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
    suggestion,
    config,
    `Your suggestion #${suggestion.suggestionNumber} in **${guild.name}** was approved.`,
    suggestion.staffActorId ?? undefined,
  );

  return { suggestion };
}

export async function refreshFeedMessage(
  client: Client,
  config: SuggestionsConfig,
  suggestion: Suggestion,
): Promise<void> {
  if (!suggestion.feedChannelId || !suggestion.feedMessageId) return;
  const channel = await resolveTextChannel(client, suggestion.feedChannelId);
  if (!channel) return;
  const msg = await channel.messages.fetch(suggestion.feedMessageId).catch(() => null);
  if (!msg) return;
  const votes = await getVoteTotals(suggestion.id);
  const comments = await listComments(suggestion.id);
  const embed = buildSuggestionEmbed({ client, suggestion, config, votes, comments });
  const components =
    config.voting_enabled && suggestion.status === "approved"
      ? [voteActionRow(suggestion.id, config, votes)]
      : [];
  await msg.edit({ embeds: [embed], components }).catch(() => null);
}

export async function approveSuggestion(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  comment?: string | null;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: "Suggestion not found." };
  }
  if (suggestion.status !== "awaiting_review") {
    return { suggestion, error: "This suggestion is not awaiting review." };
  }

  let updated =
    (await updateSuggestion(suggestion.id, { staffActorId: options.staffId, status: "approved" })) ??
    suggestion;

  if (options.comment?.trim()) {
    await addComment({
      suggestionId: suggestion.id,
      authorId: options.staffId,
      content: options.comment.trim(),
      anonymous: false,
    });
  }

  if (suggestion.reviewChannelId && suggestion.reviewMessageId) {
    const channel = await resolveTextChannel(options.client, suggestion.reviewChannelId);
    const msg = channel ? await channel.messages.fetch(suggestion.reviewMessageId).catch(() => null) : null;
    if (msg) {
      const embed = buildSuggestionEmbed({
        client: options.client,
        suggestion: updated,
        config: options.config,
        titlePrefix: "Approved",
      });
      await msg.edit({ embeds: [embed], components: [disabledQueueRow()] }).catch(() => null);
    }
  }

  const posted = await postToFeed({
    client: options.client,
    guild: options.guild,
    config: options.config,
    suggestion: updated,
  });
  return posted;
}

export async function denySuggestion(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  reason?: string | null;
  silent?: boolean;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: "Suggestion not found." };
  }
  if (suggestion.status === "denied") {
    return { suggestion, error: "This suggestion is already denied." };
  }

  let updated =
    (await updateSuggestion(suggestion.id, {
      status: "denied",
      staffActorId: options.staffId,
      denialReason: options.reason?.trim() || null,
    })) ?? suggestion;

  if (suggestion.reviewChannelId && suggestion.reviewMessageId) {
    const channel = await resolveTextChannel(options.client, suggestion.reviewChannelId);
    const msg = channel ? await channel.messages.fetch(suggestion.reviewMessageId).catch(() => null) : null;
    if (msg) {
      const embed = buildSuggestionEmbed({
        client: options.client,
        suggestion: updated,
        config: options.config,
        titlePrefix: "Denied",
      });
      await msg.edit({ embeds: [embed], components: [disabledQueueRow()] }).catch(() => null);
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
        titlePrefix: "Denied",
      });
      const msg = await deniedChannel.send({ embeds: [embed] });
      updated =
        (await updateSuggestion(updated.id, {
          deniedChannelId: deniedChannel.id,
          deniedMessageId: msg.id,
        })) ?? updated;
    }

    await notifyWatchers(
      options.client,
      updated,
      options.config,
      `Your suggestion #${updated.suggestionNumber} in **${options.guild.name}** was denied${
        options.reason ? `: ${options.reason}` : "."
      }`,
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
  comment?: string | null;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: "Suggestion not found." };
  }
  if (suggestion.status !== "approved") {
    return { suggestion, error: "Only approved suggestions can be marked." };
  }

  if (options.comment?.trim()) {
    await addComment({
      suggestionId: suggestion.id,
      authorId: options.staffId,
      content: options.comment.trim(),
      anonymous: false,
    });
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
      const comments = await listComments(updated.id);
      const embed = buildSuggestionEmbed({
        client: options.client,
        suggestion: updated,
        config: options.config,
        votes,
        comments,
        titlePrefix: "Implemented",
      });
      const msg = await archive.send({ embeds: [embed] });
      updated =
        (await updateSuggestion(updated.id, {
          archiveChannelId: archive.id,
          archiveMessageId: msg.id,
        })) ?? updated;
    }
  }

  await refreshFeedMessage(options.client, options.config, updated);
  await notifyWatchers(
    options.client,
    updated,
    options.config,
    `Suggestion #${updated.suggestionNumber} in **${options.guild.name}** was marked **${options.displayStatus}**.`,
    options.staffId,
  );

  return { suggestion: updated };
}

export async function commentOnSuggestion(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  content: string;
  anonymous?: boolean;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: "Suggestion not found." };
  }

  await addComment({
    suggestionId: suggestion.id,
    authorId: options.staffId,
    content: options.content.trim(),
    anonymous: options.anonymous ?? false,
  });

  await refreshFeedMessage(options.client, options.config, suggestion);
  await notifyWatchers(
    options.client,
    suggestion,
    options.config,
    `New comment on suggestion #${suggestion.suggestionNumber} in **${options.guild.name}**: ${options.content.trim().slice(0, 200)}`,
    options.staffId,
  );

  return { suggestion };
}

export async function deleteSuggestion(options: {
  client: Client;
  guild: Guild;
  config: SuggestionsConfig;
  suggestionId: number;
  staffId: string;
  silent?: boolean;
}): Promise<{ suggestion: Suggestion | null; error?: string }> {
  const suggestion = await getSuggestionById(options.suggestionId);
  if (!suggestion || suggestion.guildId !== options.guild.id) {
    return { suggestion: null, error: "Suggestion not found." };
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

  const updated =
    (await updateSuggestion(suggestion.id, {
      status: "denied",
      staffActorId: options.staffId,
      denialReason: options.silent ? "Deleted" : suggestion.denialReason ?? "Deleted",
      feedChannelId: null,
      feedMessageId: null,
      reviewMessageId: null,
    })) ?? suggestion;

  if (!options.silent) {
    await notifyWatchers(
      options.client,
      updated,
      options.config,
      `Suggestion #${updated.suggestionNumber} in **${options.guild.name}** was deleted.`,
      options.staffId,
    );
  }

  return { suggestion: updated };
}

export async function autoFollowOnUpvote(
  config: SuggestionsConfig,
  suggestionId: number,
  userId: string,
): Promise<void> {
  if (!config.follow_on_upvote) return;
  await followSuggestion(suggestionId, userId);
}
