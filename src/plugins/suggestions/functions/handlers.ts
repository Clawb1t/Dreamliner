import type { ButtonInteraction, GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zSuggestionsConfig } from "../../../config/schemas/suggestions.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { hasPluginPermission, resolvePluginConfig } from "../../../core/permissions.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { resultEdit, resultReply, guildResultOptions } from "../../../core/responses.js";
import { parseSuggestCustomId, SUGGEST_PREFIX } from "../constants.js";
import { getSuggestionById, setVote } from "./store.js";
import { approveSuggestion, autoFollowOnUpvote, denySuggestion, refreshFeedMessage } from "./service.js";

export async function handleSuggestionButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(SUGGEST_PREFIX)) return false;
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const parsed = parseSuggestCustomId(interaction.customId);
  if (!parsed) return false;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (guildConfig.plugins.suggestions?.enabled === false) {
    await interaction.reply(resultReply("Plugin disabled", "Suggestions are disabled.", true));
    return true;
  }

  const member = interaction.member as GuildMember;
  const categoryId =
    interaction.channel?.isTextBased() && "parentId" in interaction.channel
      ? interaction.channel.parentId
      : null;
  const defaults = getPluginDefaultOverrides("suggestions");
  const config = zSuggestionsConfig.parse(
    resolvePluginConfig(
      guildConfig,
      "suggestions",
      defaults,
      member,
      interaction.channelId ?? "",
      categoryId,
    ),
  );
  const ephemeral = resolveEphemeral(guildConfig);

  if (parsed.kind === "queue") {
    const permission = parsed.action === "approve" ? "can_approve" : "can_deny";
    if (
      !hasPluginPermission(
        guildConfig,
        "suggestions",
        permission,
        member,
        interaction.channelId ?? "",
        categoryId,
        defaults,
      )
    ) {
      await interaction.reply(
        resultReply("Permission denied", "You cannot manage the suggestion queue.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
      );
      return true;
    }

    await interaction.deferReply({ ephemeral: true });
    const result =
      parsed.action === "approve"
        ? await approveSuggestion({
            client: interaction.client,
            guild: interaction.guild,
            config,
            suggestionId: parsed.id,
            staffId: member.id,
          })
        : await denySuggestion({
            client: interaction.client,
            guild: interaction.guild,
            config,
            suggestionId: parsed.id,
            staffId: member.id,
          });

    if (result.error || !result.suggestion) {
      await interaction.editReply(
        resultEdit("Error", result.error ?? "Failed.", guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
      );
      return true;
    }

    await interaction.editReply(
      resultEdit(
        parsed.action === "approve" ? "Approved" : "Denied",
        `Suggestion #${result.suggestion.suggestionNumber} was ${parsed.action === "approve" ? "approved" : "denied"}.`,
        guildResultOptions(interaction.client, guildConfig, {
          tone: "success",
          emoji:
            parsed.action === "approve"
              ? "<:icons_upvote:1544417455689179349>"
              : "<:icons_downvote:1544417248209404054>",
        }),
      ),
    );
    return true;
  }

  // vote
  if (!config.voting_enabled) {
    await interaction.reply(
      resultReply(
        "Voting disabled",
        "Voting is turned off for this server.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig),
      ),
    );
    return true;
  }

  if (
    !hasPluginPermission(
      guildConfig,
      "suggestions",
      "can_vote",
      member,
      interaction.channelId ?? "",
      categoryId,
      defaults,
    )
  ) {
    await interaction.reply(
      resultReply("Permission denied", "You cannot vote on suggestions.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  if (config.allowed_vote_roles.length > 0) {
    const ok = config.allowed_vote_roles.some((id) => member.roles.cache.has(id));
    if (!ok) {
      await interaction.reply(
        resultReply("Not allowed", "You need a voting role to vote.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
      );
      return true;
    }
  }

  const suggestion = await getSuggestionById(parsed.id);
  if (!suggestion || suggestion.guildId !== interaction.guildId || suggestion.status !== "approved") {
    await interaction.reply(
      resultReply(
        "Unavailable",
        "This suggestion cannot be voted on.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig),
      ),
    );
    return true;
  }

  if (!config.allow_self_vote && suggestion.authorId === member.id) {
    await interaction.reply(
      resultReply("Not allowed", "You cannot vote on your own suggestion.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
    );
    return true;
  }

  if (parsed.value === "mid" && !config.mid_vote_enabled) {
    await interaction.reply(
      resultReply(
        "Unavailable",
        "Neutral votes are disabled.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig),
      ),
    );
    return true;
  }

  await interaction.deferUpdate();
  const voteResult = await setVote(suggestion.id, member.id, parsed.value);
  if (parsed.value === "up" && voteResult.action !== "removed") {
    await autoFollowOnUpvote(config, suggestion.id, member.id);
  }
  await refreshFeedMessage(interaction.client, config, suggestion);
  return true;
}
