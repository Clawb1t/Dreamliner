import * as Discord from "discord.js";
import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { zReviewsConfig } from "../../../config/schemas/reviews.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { hasPluginPermission, resolvePluginConfig } from "../../../core/permissions.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import { checkFeedbackEligibility } from "../../feedback/eligibility.js";
import {
  createReview,
  getActiveReviewByUser,
  updateReview,
} from "./store.js";
import { buildReviewEmbed, resolveTextChannel } from "./embeds.js";

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

export function buildReviewModal(options?: { minRating?: number; maxRating?: number; requireText?: boolean }) {
  const min = options?.minRating ?? 1;
  const max = options?.maxRating ?? 5;
  const modal = new ModalBuilder().setCustomId(REVIEW_MODAL_ID).setTitle("Server review");

  const ratingOptions = [];
  for (let i = max; i >= min; i--) {
    const option = new RadioGroupOptionBuilder()
      .setValue(String(i))
      .setLabel(`${"\u2605".repeat(i)}${"\u2606".repeat(5 - i)} (${i}/5)`)
      .setDefault(i === Math.min(5, max));
    if (i === 5) option.setDescription("Excellent");
    if (i === 1) option.setDescription("Poor");
    ratingOptions.push(option);
  }

  (modal as ModalBuilder & { addLabelComponents: (...args: unknown[]) => ModalBuilder }).addLabelComponents(
    new LabelBuilder()
      .setLabel("Rating")
      .setDescription("How would you rate this server?")
      .setRadioGroupComponent(
        new RadioGroupBuilder().setCustomId(FIELD.rating).setRequired(true).addOptions(...ratingOptions),
      ),
    new LabelBuilder()
      .setLabel("Feedback")
      .setDescription("Tell staff what you like or what could improve.")
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(FIELD.content)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(options?.requireText ?? true)
          .setMaxLength(1000)
          .setPlaceholder("Your feedback..."),
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
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply("Server only", "Reviews can only be submitted in a server.", true));
    return;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const section = guildConfig.plugins.reviews;
  if (section?.enabled === false) {
    await interaction.reply(
      resultReply("Plugin disabled", "Reviews are disabled for this server.", true, undefined, undefined),
    );
    return;
  }

  const member = interaction.member as import("discord.js").GuildMember;
  const categoryId =
    interaction.channel?.isTextBased() && "parentId" in interaction.channel
      ? interaction.channel.parentId
      : null;
  const defaults = getPluginDefaultOverrides("reviews");
  const ephemeral = resolveEphemeral(guildConfig);

  if (
    !hasPluginPermission(
      guildConfig,
      "reviews",
      "can_review",
      member,
      interaction.channelId ?? "",
      categoryId,
      defaults,
    )
  ) {
    await interaction.reply(
      resultReply("Permission denied", "You do not have permission to submit reviews.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return;
  }

  const pluginConfig = zReviewsConfig.parse(
    resolvePluginConfig(guildConfig, "reviews", defaults, member, interaction.channelId ?? "", categoryId),
  );

  const existing = await getActiveReviewByUser(interaction.guildId!, member.id);
  if (existing && !pluginConfig.allow_edit) {
    await interaction.reply(
      resultReply(
        "Already reviewed",
        "You have already submitted a review for this server.",
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
      resultReply("Not eligible", eligibility.message, ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "warning" })),
    );
    return;
  }

  const ratingRaw = getRadioValue(interaction, FIELD.rating);
  const rating = Number(ratingRaw);
  if (!Number.isFinite(rating) || rating < pluginConfig.min_rating || rating > pluginConfig.max_rating) {
    await interaction.reply(
      resultReply(
        "Invalid rating",
        `Choose a rating between ${pluginConfig.min_rating} and ${pluginConfig.max_rating}.`,
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
        "Comment required",
        `Please write at least ${pluginConfig.min_text_length} characters.`,
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }
  if (content.length > pluginConfig.max_text_length) {
    await interaction.reply(
      resultReply(
        "Too long",
        `Keep your comment under ${pluginConfig.max_text_length} characters.`,
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
      resultReply("Error", "Could not save your review.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
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
    });

    try {
      if (existing?.channelId && existing.messageId && existing.channelId === channel.id) {
        const msg = await channel.messages.fetch(existing.messageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          review = (await updateReview(review.id, { channelId: channel.id, messageId: msg.id })) ?? review;
        } else {
          const sent = await channel.send({ embeds: [embed] });
          review = (await updateReview(review.id, { channelId: channel.id, messageId: sent.id })) ?? review;
        }
      } else {
        const sent = await channel.send({ embeds: [embed] });
        review = (await updateReview(review.id, { channelId: channel.id, messageId: sent.id })) ?? review;
      }
    } catch (error) {
      console.error("[reviews] Failed to post review embed:", error);
    }
  }

  await interaction.reply(
    resultReply(
      existing ? "Review updated" : "Review submitted",
      `Thanks! Your review (#${review.id}) was ${existing ? "updated" : "saved"}${channel ? ` and posted in <#${channel.id}>` : ""}.`,
      ephemeral,
      guildResultOptions(interaction.client, guildConfig, { tone: "success" }),
    ),
  );
}
