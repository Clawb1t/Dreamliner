import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { zSuggestionsConfig } from "../../../config/schemas/suggestions.js";
import { hasPermission, resolveEffectivePluginConfig } from "../../../core/permissionRoles.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { resultEdit, resultReply, guildResultOptions } from "../../../core/responses.js";
import { checkFeedbackEligibility } from "../../feedback/eligibility.js";
import { SUGGEST_ANON_MODAL_ID, SUGGEST_MODAL_ID } from "../constants.js";
import { countOpenApproved, getLastSuggestionAt, isBlocked } from "./store.js";
import { submitSuggestion } from "./service.js";
import { defaultTranslator, translatorFor, type Translator } from "../../../i18n/index.js";

export function buildSuggestModal(anonymous: boolean, t: Translator = defaultTranslator): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(anonymous ? SUGGEST_ANON_MODAL_ID : SUGGEST_MODAL_ID)
    .setTitle(anonymous ? t("suggestions.modal.anonymousTitle", "Anonymous suggestion") : t("suggestions.modal.title", "Suggestion"));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("dl:suggest:content")
        .setLabel(t("suggestions.modal.contentLabel", "Your suggestion"))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(1000)
        .setPlaceholder(t("suggestions.modal.contentPlaceholder", "Describe your idea...")),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("dl:suggest:image")
        .setLabel(t("suggestions.modal.imageLabel", "Image URL (optional)"))
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(500)
        .setPlaceholder(t("suggestions.modal.imagePlaceholder", "https://...")),
    ),
  );

  return modal;
}

export async function handleSuggestModalSubmit(
  interaction: ModalSubmitInteraction,
  configManager: ConfigManager,
): Promise<void> {
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(
      resultReply(
        t("suggestions.serverOnlyTitle", "Server only"),
        t("suggestions.serverOnlyBody", "Suggestions can only be submitted in a server."),
        true,
      ),
    );
    return;
  }

  const anonymous = interaction.customId === SUGGEST_ANON_MODAL_ID;
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (guildConfig.plugins.suggestions?.enabled === false) {
    await interaction.reply(
      resultReply(
        t("suggestions.pluginDisabledTitle", "Plugin disabled"),
        t("suggestions.pluginDisabledBody", "Suggestions are disabled for this server."),
        true,
      ),
    );
    return;
  }

  const member = interaction.member as import("discord.js").GuildMember;
  const ephemeral = resolveEphemeral(guildConfig);

  if (
    !(await hasPermission(
      interaction.guildId!,
      "suggestions",
      "can_suggest",
      member,
      guildConfig,
    ))
  ) {
    await interaction.reply(
      resultReply(
        t("suggestions.permissionDeniedTitle", "Permission denied"),
        t("suggestions.permissionDeniedSubmitBody", "You do not have permission to submit suggestions."),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  const config = zSuggestionsConfig.parse(
    await resolveEffectivePluginConfig(interaction.guildId!, "suggestions", member, guildConfig),
  );

  if (anonymous && !config.anonymous) {
    await interaction.reply(
      resultReply(
        t("suggestions.anonDisabledTitle", "Anonymous disabled"),
        t("suggestions.anonDisabledOnServerBody", "Anonymous suggestions are not enabled on this server."),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
      ),
    );
    return;
  }

  if (await isBlocked(interaction.guildId!, member.id)) {
    await interaction.reply(
      resultReply(
        t("suggestions.blockedTitle", "Blocked"),
        t("suggestions.blockedOnServerBody", "You are blocked from submitting suggestions in this server."),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  const lastAt = await getLastSuggestionAt(interaction.guildId!, member.id);
  const eligibility = await checkFeedbackEligibility({
    member,
    channelId: interaction.channelId,
    config: {
      min_messages: config.min_messages,
      min_account_age: config.min_account_age,
      min_member_age: config.min_member_age,
      cooldown: config.cooldown,
      allowed_roles: config.allowed_suggest_roles,
      blocked_roles: config.blocked_suggest_roles,
      ignored_channels: config.ignored_channels,
      command_channels: config.command_channels,
    },
    lastActionAt: lastAt,
  });
  if (!eligibility.ok) {
    await interaction.reply(
      resultReply(t("suggestions.notEligibleTitle", "Not eligible"), eligibility.message, ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
    );
    return;
  }

  if (config.max_open > 0) {
    const open = await countOpenApproved(interaction.guildId!, member.id);
    if (open >= config.max_open) {
      await interaction.reply(
        resultReply(
          t("suggestions.limitReachedTitle", "Limit reached"),
          open === 1
            ? t("suggestions.limitReachedBodyOne", "You already have {open} open suggestion (max {max}).", {
                open,
                max: config.max_open,
              })
            : t("suggestions.limitReachedBodyMany", "You already have {open} open suggestions (max {max}).", {
                open,
                max: config.max_open,
              }),
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
        ),
      );
      return;
    }
  }

  if (config.mode === "review" && !config.review_channel_id) {
    await interaction.reply(
      resultReply(
        t("suggestions.notConfiguredTitle", "Not configured"),
        t("suggestions.reviewChannelNotSetBody", "Staff have not set a review channel yet."),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }
  if (config.mode === "autoapprove" && !config.suggestions_channel_id) {
    await interaction.reply(
      resultReply(
        t("suggestions.notConfiguredTitle", "Not configured"),
        t("suggestions.suggestionsChannelNotSetBody", "Staff have not set a suggestions channel yet."),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  const content = interaction.fields.getTextInputValue("dl:suggest:content").trim();
  if (content.length < config.min_length) {
    await interaction.reply(
      resultReply(
        t("suggestions.tooShortTitle", "Too short"),
        t("suggestions.tooShortBody", "Suggestions must be at least {min} characters.", { min: config.min_length }),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }
  if (content.length > config.max_length) {
    await interaction.reply(
      resultReply(
        t("suggestions.tooLongTitle", "Too long"),
        t("suggestions.tooLongBody", "Suggestions must be under {max} characters.", { max: config.max_length }),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  let attachmentUrl: string | null = null;
  const imageRaw = interaction.fields.getTextInputValue("dl:suggest:image")?.trim() || "";
  if (imageRaw) {
    if (!config.allow_attachments) {
      await interaction.reply(
        resultReply(
          t("suggestions.attachmentsDisabledTitle", "Attachments disabled"),
          t("suggestions.attachmentsDisabledBody", "Image attachments are not allowed on this server."),
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
        ),
      );
      return;
    }
    if (!/^https:\/\/\S+$/i.test(imageRaw)) {
      await interaction.reply(
        resultReply(
          t("suggestions.invalidImageUrlTitle", "Invalid image URL"),
          t("suggestions.invalidImageUrlBody", "Provide a valid `https://` image URL."),
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return;
    }
    attachmentUrl = imageRaw;
  }

  await interaction.deferReply({ ephemeral });

  const result = await submitSuggestion({
    client: interaction.client,
    guild: interaction.guild,
    author: member,
    guildConfig,
    config,
    content,
    attachmentUrl,
    anonymous,
    t,
  });

  if (result.error) {
    await interaction.editReply(
      resultEdit(t("suggestions.errorTitle", "Error"), result.error, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return;
  }

  const bodyText =
    result.suggestion.status === "awaiting_review"
      ? t(
          "suggestions.submittedQueueBody",
          "Suggestion **#{num}** was sent to the staff review queue.",
          { num: result.suggestion.suggestionNumber },
        )
      : t(
          "suggestions.submittedFeedBody",
          "Suggestion **#{num}** was posted in <#{channel}>.",
          { num: result.suggestion.suggestionNumber, channel: result.suggestion.feedChannelId ?? "" },
        );

  await interaction.editReply(
    resultEdit(
      t("suggestions.submittedTitle", "Suggestion submitted"),
      bodyText,
      guildResultOptions(interaction.client, guildConfig, {
        tone: "success",
        emoji: "<:icons_bulb:1544417162050142428>",
      }),
    ),
  );
}
