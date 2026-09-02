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

export function buildSuggestModal(anonymous: boolean): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(anonymous ? SUGGEST_ANON_MODAL_ID : SUGGEST_MODAL_ID)
    .setTitle(anonymous ? "Anonymous suggestion" : "Suggestion");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("dl:suggest:content")
        .setLabel("Your suggestion")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(1000)
        .setPlaceholder("Describe your idea..."),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("dl:suggest:image")
        .setLabel("Image URL (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(500)
        .setPlaceholder("https://..."),
    ),
  );

  return modal;
}

export async function handleSuggestModalSubmit(
  interaction: ModalSubmitInteraction,
  configManager: ConfigManager,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply("Server only", "Suggestions can only be submitted in a server.", true));
    return;
  }

  const anonymous = interaction.customId === SUGGEST_ANON_MODAL_ID;
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (guildConfig.plugins.suggestions?.enabled === false) {
    await interaction.reply(resultReply("Plugin disabled", "Suggestions are disabled for this server.", true));
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
        "Permission denied",
        "You do not have permission to submit suggestions.",
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
        "Anonymous disabled",
        "Anonymous suggestions are not enabled on this server.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
      ),
    );
    return;
  }

  if (await isBlocked(interaction.guildId!, member.id)) {
    await interaction.reply(
      resultReply(
        "Blocked",
        "You are blocked from submitting suggestions in this server.",
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
      resultReply("Not eligible", eligibility.message, ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
    );
    return;
  }

  if (config.max_open > 0) {
    const open = await countOpenApproved(interaction.guildId!, member.id);
    if (open >= config.max_open) {
      await interaction.reply(
        resultReply(
          "Limit reached",
          `You already have ${open} open suggestion${open === 1 ? "" : "s"} (max ${config.max_open}).`,
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
        "Not configured",
        "Staff have not set a review channel yet.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }
  if (config.mode === "autoapprove" && !config.suggestions_channel_id) {
    await interaction.reply(
      resultReply(
        "Not configured",
        "Staff have not set a suggestions channel yet.",
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
        "Too short",
        `Suggestions must be at least ${config.min_length} characters.`,
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }
  if (content.length > config.max_length) {
    await interaction.reply(
      resultReply(
        "Too long",
        `Suggestions must be under ${config.max_length} characters.`,
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
          "Attachments disabled",
          "Image attachments are not allowed on this server.",
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
        ),
      );
      return;
    }
    if (!/^https:\/\/\S+$/i.test(imageRaw)) {
      await interaction.reply(
        resultReply(
          "Invalid image URL",
          "Provide a valid `https://` image URL.",
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
    config,
    content,
    attachmentUrl,
    anonymous,
  });

  if (result.error) {
    await interaction.editReply(
      resultEdit("Error", result.error, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return;
  }

  const where =
    result.suggestion.status === "awaiting_review"
      ? "sent to the staff review queue"
      : `posted in <#${result.suggestion.feedChannelId}>`;

  await interaction.editReply(
    resultEdit(
      "Suggestion submitted",
      `Suggestion **#${result.suggestion.suggestionNumber}** was ${where}.`,
      guildResultOptions(interaction.client, guildConfig, {
        tone: "success",
        emoji: "<:icons_bulb:1544417162050142428>",
      }),
    ),
  );
}
