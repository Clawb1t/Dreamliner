import * as Discord from "discord.js";
import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { zReviewsConfig } from "../../../config/schemas/reviews.js";
import { hasPermission, resolveEffectivePluginConfig } from "../../../core/permissionRoles.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { containerEdit, containerReply, resultReply, guildResultOptions } from "../../../core/responses.js";
import { checkFeedbackEligibility } from "../../feedback/eligibility.js";
import {
  createReview,
  getActiveReviewByUser,
  updateReview,
} from "./store.js";
import { buildReviewEmbed, resolveTextChannel } from "./embeds.js";
import { getLogger } from "../../../core/logger.js";
import { translatorFor, type Translator } from "../../../i18n/index.js";
const log = getLogger("reviews");

type AnyLabelBuilder = {
  setLabel(label: string): AnyLabelBuilder;
  setDescription(description: string): AnyLabelBuilder;
  setTextInputComponent(input: unknown): AnyLabelBuilder;
  setRadioGroupComponent(input: unknown): AnyLabelBuilder;
};

type AnyRadioGroupOptionBuilder = {
  setValue(value: string): AnyRadioGroupOptionBuilder;
  setLabel(label: string): AnyRadioGroupOptionBuilder;
  setDescription(description: string): AnyRadioGroupOptionBuilder;
  setDefault(isDefault?: boolean): AnyRadioGroupOptionBuilder;
};

type AnyRadioGroupBuilder = {
  setCustomId(customId: string): AnyRadioGroupBuilder;
  setRequired(required?: boolean): AnyRadioGroupBuilder;
  addOptions(...options: AnyRadioGroupOptionBuilder[]): AnyRadioGroupBuilder;
};

const DiscordBuilders = Discord as unknown as {
  LabelBuilder: new () => AnyLabelBuilder;
  RadioGroupBuilder: new () => AnyRadioGroupBuilder;
  RadioGroupOptionBuilder: new () => AnyRadioGroupOptionBuilder;
};

const LabelBuilder = DiscordBuilders.LabelBuilder;
const RadioGroupBuilder = DiscordBuilders.RadioGroupBuilder;
const RadioGroupOptionBuilder = DiscordBuilders.RadioGroupOptionBuilder;

export const REVIEW_MODAL_ID = "dl:review:submit";

const FIELD = {
  rating: "dl:review:rating",
  content: "dl:review:content",
} as const;

export function buildReviewModal(
  t: Translator,
  options?: { minRating?: number; maxRating?: number; requireText?: boolean },
) {
  const min = options?.minRating ?? 1;
  const max = options?.maxRating ?? 5;
  const modal = new ModalBuilder().setCustomId(REVIEW_MODAL_ID).setTitle(t("reviews.modal.title", "Server review"));

  const ratingOptions = [];
  for (let i = max; i >= min; i--) {
    const option = new RadioGroupOptionBuilder()
      .setValue(String(i))
      .setLabel(`${"\u2605".repeat(i)}${"\u2606".repeat(5 - i)} (${i}/5)`)
      .setDefault(i === Math.min(5, max));
    if (i === 5) option.setDescription(t("reviews.modal.ratingExcellent", "Excellent"));
    if (i === 1) option.setDescription(t("reviews.modal.ratingPoor", "Poor"));
    ratingOptions.push(option);
  }

  (modal as ModalBuilder & { addLabelComponents: (...args: unknown[]) => ModalBuilder }).addLabelComponents(
    new LabelBuilder()
      .setLabel(t("reviews.modal.ratingLabel", "Rating"))
      .setDescription(t("reviews.modal.ratingDescription", "How would you rate this server?"))
      .setRadioGroupComponent(
        new RadioGroupBuilder().setCustomId(FIELD.rating).setRequired(true).addOptions(...ratingOptions),
      ),
    new LabelBuilder()
      .setLabel(t("reviews.modal.feedbackLabel", "Feedback"))
      .setDescription(t("reviews.modal.feedbackDescription", "Tell staff what you like or what could improve."))
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(FIELD.content)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(options?.requireText ?? true)
          .setMaxLength(1000)
          .setPlaceholder(t("reviews.modal.feedbackPlaceholder", "Your feedback...")),
      ),
  );

  return modal;
}

function getRadioValue(interaction: ModalSubmitInteraction, customId: string): string | null {
  const fields = interaction.fields as unknown as {
    getRadioGroup?: (id: string, required?: boolean) => string;
    getTextInputValue: (id: string) => string;
  };
  try {
    if (typeof fields.getRadioGroup === "function") {
      return fields.getRadioGroup(customId, true);
    }
  } catch {
    // fall through
  }
  try {
    return fields.getTextInputValue(customId);
  } catch {
    return null;
  }
}

export async function handleReviewModalSubmit(
  interaction: ModalSubmitInteraction,
  configManager: ConfigManager,
): Promise<void> {
  const { t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(
      resultReply(t("reviews.serverOnly.title", "Server only"), t("reviews.serverOnly.description", "Reviews can only be submitted in a server."), true),
    );
    return;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const section = guildConfig.plugins.reviews;
  if (section?.enabled === false) {
    await interaction.reply(
      resultReply(
        t("reviews.pluginDisabled.title", "Plugin disabled"),
        t("reviews.pluginDisabled.description", "Reviews are disabled for this server."),
        true,
        undefined,
        undefined,
      ),
    );
    return;
  }

  const member = interaction.member as import("discord.js").GuildMember;
  const ephemeral = resolveEphemeral(guildConfig);

  if (
    !(await hasPermission(
      interaction.guildId!,
      "reviews",
      "can_review",
      member,
      guildConfig,
    ))
  ) {
    await interaction.reply(
      resultReply(
        t("reviews.permissionDenied.title", "Permission denied"),
        t("reviews.permissionDenied.description", "You do not have permission to submit reviews."),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  const pluginConfig = zReviewsConfig.parse(
    await resolveEffectivePluginConfig(interaction.guildId!, "reviews", member, guildConfig),
  );

  const existing = await getActiveReviewByUser(interaction.guildId!, member.id);
  if (existing && !pluginConfig.allow_edit) {
    await interaction.reply(
      resultReply(
        t("reviews.alreadyReviewed.title", "Already reviewed"),
        t("reviews.alreadyReviewed.description", "You have already submitted a review for this server."),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig),
      ),
    );
    return;
  }

  const eligibility = await checkFeedbackEligibility({
    member,
    channelId: interaction.channelId,
    config: {
      min_messages: pluginConfig.min_messages,
      min_account_age: pluginConfig.min_account_age,
      min_member_age: pluginConfig.min_member_age,
      cooldown: pluginConfig.cooldown,
      allowed_roles: pluginConfig.allowed_roles,
      blocked_roles: pluginConfig.blocked_roles,
      ignored_channels: pluginConfig.ignored_channels,
    },
    lastActionAt: existing?.updatedAt ?? null,
  });
  if (!eligibility.ok) {
    await interaction.reply(
      resultReply(t("reviews.notEligible.title", "Not eligible"), eligibility.message, ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
    );
    return;
  }

  const ratingRaw = getRadioValue(interaction, FIELD.rating);
  const rating = Number(ratingRaw);
  if (!Number.isFinite(rating) || rating < pluginConfig.min_rating || rating > pluginConfig.max_rating) {
    await interaction.reply(
      resultReply(
        t("reviews.invalidRating.title", "Invalid rating"),
        t("reviews.invalidRating.description", "Choose a rating between {min} and {max}.", {
          min: pluginConfig.min_rating,
          max: pluginConfig.max_rating,
        }),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  const content = (interaction.fields.getTextInputValue(FIELD.content) ?? "").trim();
  if (pluginConfig.require_text && content.length < pluginConfig.min_text_length) {
    await interaction.reply(
      resultReply(
        t("reviews.commentRequired.title", "Comment required"),
        t("reviews.commentRequired.description", "Please write at least {min} characters.", {
          min: pluginConfig.min_text_length,
        }),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }
  if (content.length > pluginConfig.max_text_length) {
    await interaction.reply(
      resultReply(
        t("reviews.tooLong.title", "Too long"),
        t("reviews.tooLong.description", "Keep your comment under {max} characters.", {
          max: pluginConfig.max_text_length,
        }),
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  const anonymous = pluginConfig.anonymous;
  let review = existing
    ? await updateReview(existing.id, { rating, content, anonymous })
    : await createReview({
        guildId: interaction.guildId!,
        userId: member.id,
        rating,
        content,
        anonymous,
      });

  if (!review) {
    await interaction.reply(
      resultReply(t("reviews.error.title", "Error"), t("reviews.error.description", "Could not save your review."), ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return;
  }

  const channel = await resolveTextChannel(interaction.client, pluginConfig.review_channel_id);
  if (channel) {
    const embed = buildReviewEmbed({
      client: interaction.client,
      review,
      authorTag: member.user.tag,
      authorAvatar: member.user.displayAvatarURL({ size: 128 }),
      t,
    });

    try {
      if (existing?.channelId && existing.messageId && existing.channelId === channel.id) {
        const msg = await channel.messages.fetch(existing.messageId).catch(() => null);
        if (msg) {
          await msg.edit(containerEdit(embed));
          review = (await updateReview(review.id, { channelId: channel.id, messageId: msg.id })) ?? review;
        } else {
          const sent = await channel.send(containerReply(embed));
          review = (await updateReview(review.id, { channelId: channel.id, messageId: sent.id })) ?? review;
        }
      } else {
        const sent = await channel.send(containerReply(embed));
        review = (await updateReview(review.id, { channelId: channel.id, messageId: sent.id })) ?? review;
      }
    } catch (error) {
      log.error("[reviews] Failed to post review embed:", error);
    }
  }

  const reviewTitle = existing
    ? t("reviews.submitted.titleUpdated", "Review updated")
    : t("reviews.submitted.titleSubmitted", "Review submitted");
  const reviewDescription = channel
    ? existing
      ? t("reviews.submitted.descriptionUpdatedPosted", "Thanks! Your review (#{id}) was updated and posted in <#{channelId}>.", { id: review.id, channelId: channel.id })
      : t("reviews.submitted.descriptionSavedPosted", "Thanks! Your review (#{id}) was saved and posted in <#{channelId}>.", { id: review.id, channelId: channel.id })
    : existing
      ? t("reviews.submitted.descriptionUpdated", "Thanks! Your review (#{id}) was updated.", { id: review.id })
      : t("reviews.submitted.descriptionSaved", "Thanks! Your review (#{id}) was saved.", { id: review.id });

  await interaction.reply(
    resultReply(
      reviewTitle,
      reviewDescription,
      ephemeral,
      guildResultOptions(interaction.client, guildConfig, {
        tone: "success",
        emoji: "<:icons_star:1544417435636080741>",
      }),
    ),
  );
}
