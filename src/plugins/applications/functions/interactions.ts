import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import { APPLICATION_EMOJIS, type ApplicationOpening, type ApplicationsConfig } from "../../../config/schemas/applications.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import { buildFormModal, paginateQuestions, readFormAnswer, readFormFiles, type FormAnswer } from "../../../core/formModal.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";
import type { EmbedTone } from "../../../core/embeds.js";
import { translatorFor, type Translator } from "../../../i18n/index.js";
import {
  APPLICATION_PREFIX,
  APPLICATION_REASON_FIELD_ID,
  applicationContinueId,
  applicationDenyModalId,
  applicationFieldId,
  applicationModalId,
  parseApplicationCustomId,
} from "../constants.js";
import { findOpening, loadApplicationsConfig, modalTitle, openingName, PLUGIN } from "./config.js";
import { clearDraft, getDraft, saveDraft } from "./drafts.js";
import { applyBlocker } from "./eligibility.js";
import { decide, postForReview } from "./review.js";
import { createApplication } from "./store.js";

type Ctx = {
  t: Translator;
  guildConfig: GuildConfig;
  config: ApplicationsConfig;
  member: GuildMember;
};

async function reply(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: Pick<Ctx, "guildConfig">,
  title: string,
  body: string,
  tone: EmbedTone,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
  emoji?: string,
): Promise<void> {
  const options = guildResultOptions(interaction.client, ctx.guildConfig, { tone, ...(emoji ? { emoji } : {}) });
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(resultEdit(title, body, options));
    return;
  }
  await interaction.reply(resultReply(title, body, true, options, components));
}

/** Resolves everything a handler needs, or replies with why it can't continue. */
async function resolveContext(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<Ctx | null> {
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply(t("applications.serverOnlyTitle", "Server only"), t("applications.useInServerBody", "Use this in a server."), true));
    return null;
  }
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, PLUGIN)) {
    await interaction.reply(
      resultReply(
        t("applications.disabledTitle", "Applications are off"),
        t("applications.disabledBody", "Applications are turned off for this server."),
        true,
      ),
    );
    return null;
  }
  return { t, guildConfig, config: loadApplicationsConfig(guildConfig), member: interaction.member as GuildMember };
}

function showPage(interaction: ButtonInteraction, opening: ApplicationOpening, page: number): Promise<void> {
  const pages = paginateQuestions(opening.questions);
  const title = pages.length > 1 ? `${modalTitle(opening).slice(0, 36)} (${page + 1}/${pages.length})` : modalTitle(opening);
  return interaction.showModal(
    buildFormModal({
      customId: applicationModalId(opening.id, page),
      title,
      questions: pages[page] ?? [],
      fieldId: applicationFieldId,
    }),
  );
}

async function handleApply(interaction: ButtonInteraction, ctx: Ctx, openingId: string, page: number): Promise<void> {
  const { t } = ctx;
  const opening = findOpening(ctx.config, openingId);
  if (!opening) {
    await reply(interaction, ctx, t("applications.unavailableTitle", "Unavailable"), t("applications.unavailableBody", "This application is no longer available."), "error");
    return;
  }
  const blocker = applyBlocker(ctx.member, opening, t);
  if (blocker) {
    await reply(interaction, ctx, t("applications.cantApplyTitle", "Can't apply"), blocker, "warning");
    return;
  }

  if (page === 0) {
    clearDraft(interaction.guildId!, interaction.user.id, opening.id);
  } else {
    const draft = getDraft(interaction.guildId!, interaction.user.id, opening.id);
    if (!draft || draft.pagesDone !== page) {
      await reply(
        interaction,
        ctx,
        t("applications.expiredTitle", "Form expired"),
        t("applications.expiredBody", "Your progress on this application expired. Press the apply button to start again."),
        "warning",
      );
      return;
    }
  }
  await showPage(interaction, opening, page);
}

async function handleReviewButton(interaction: ButtonInteraction, ctx: Ctx, applicationId: number, kind: "accept" | "deny"): Promise<void> {
  const { t } = ctx;
  if (!(await hasPermission(interaction.guildId!, PLUGIN, "can_review", ctx.member, ctx.guildConfig))) {
    await reply(interaction, ctx, t("applications.noPermissionTitle", "No permission"), t("applications.noPermissionBody", "You don't have permission to review applications."), "error");
    return;
  }

  if (kind === "deny") {
    const modal = new ModalBuilder()
      .setCustomId(applicationDenyModalId(applicationId))
      .setTitle(t("applications.denyModalTitle", "Deny application"))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(APPLICATION_REASON_FIELD_ID)
            .setLabel(t("applications.reasonLabel", "Reason (optional, sent to the applicant)"))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await finishDecision(interaction, ctx, applicationId, "accepted", null);
}

async function finishDecision(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: Ctx,
  applicationId: number,
  decision: "accepted" | "denied",
  reason: string | null,
): Promise<void> {
  const { t } = ctx;
  const result = await decide(interaction.guild!, ctx.config, applicationId, decision, interaction.user.id, reason);
  if (!result.ok) {
    await reply(interaction, ctx, t("applications.alreadyReviewedTitle", "Already reviewed"), result.error, "warning");
    return;
  }
  const title =
    decision === "accepted"
      ? t("applications.acceptedTitle", "Application accepted")
      : t("applications.deniedTitle", "Application denied");
  const body = [
    t("applications.decisionBody", "Application **#{id}** from <@{user}> was {decision}.", {
      id: result.application.id,
      user: result.application.userId,
      decision: decision === "accepted" ? "accepted" : "denied",
    }),
    ...result.notes,
  ].join("\n");
  await reply(
    interaction,
    ctx,
    title,
    body,
    decision === "accepted" ? "success" : "neutral",
    undefined,
    decision === "accepted" ? APPLICATION_EMOJIS.accepted : APPLICATION_EMOJIS.denied,
  );
}

export async function handleApplicationButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseApplicationCustomId(interaction.customId);
  if (!parsed) return false;
  const ctx = await resolveContext(interaction);
  if (!ctx) return true;

  if (parsed.kind === "apply") await handleApply(interaction, ctx, parsed.openingId, 0);
  else if (parsed.kind === "next") await handleApply(interaction, ctx, parsed.openingId, parsed.page);
  else if (parsed.kind === "accept" || parsed.kind === "deny") {
    await handleReviewButton(interaction, ctx, parsed.applicationId, parsed.kind);
  }
  return true;
}

async function handleFormPage(interaction: ModalSubmitInteraction, ctx: Ctx, openingId: string, page: number): Promise<void> {
  const { t } = ctx;
  const guildId = interaction.guildId!;
  const opening = findOpening(ctx.config, openingId);
  const pages = opening ? paginateQuestions(opening.questions) : [];
  if (!opening || !pages[page]) {
    await reply(interaction, ctx, t("applications.unavailableTitle", "Unavailable"), t("applications.unavailableBody", "This application is no longer available."), "error");
    return;
  }

  const draft = page === 0 ? { answers: [] as FormAnswer[], files: [], pagesDone: 0 } : getDraft(guildId, interaction.user.id, opening.id);
  if (!draft || draft.pagesDone !== page) {
    await reply(interaction, ctx, t("applications.expiredTitle", "Form expired"), t("applications.expiredBody", "Your progress on this application expired. Press the apply button to start again."), "warning");
    return;
  }

  const answers = [...draft.answers];
  const files = [...draft.files];
  for (const [index, question] of pages[page]!.entries()) {
    const answer = readFormAnswer(question, applicationFieldId(index), interaction.fields);
    if (answer) answers.push(answer);
    files.push(...readFormFiles(question, applicationFieldId(index), interaction.fields));
  }

  // More pages to go: park what we have and hand the member a button to open the next one.
  if (page + 1 < pages.length) {
    saveDraft(guildId, interaction.user.id, opening.id, { answers, files, pagesDone: page + 1 });
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(applicationContinueId(opening.id, page + 1))
        .setLabel(t("applications.continueButton", "Continue ({page}/{total})", { page: page + 2, total: pages.length }))
        .setEmoji(APPLICATION_EMOJIS.next)
        .setStyle(ButtonStyle.Primary),
    );
    await reply(
      interaction,
      ctx,
      t("applications.pageSavedTitle", "Page {page} of {total} saved", { page: page + 1, total: pages.length }),
      t("applications.pageSavedBody", "Nice. Press **Continue** for the next page of your **{opening}** application.", {
        opening: openingName(opening),
      }),
      "neutral",
      [row],
      APPLICATION_EMOJIS.pageSaved,
    );
    return;
  }

  clearDraft(guildId, interaction.user.id, opening.id);
  // Checked again at submit: another application may have landed while this one was being filled in.
  const blocker = applyBlocker(ctx.member, opening, t);
  if (blocker) {
    await reply(interaction, ctx, t("applications.cantApplyTitle", "Can't apply"), blocker, "warning");
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const application = createApplication({
    guildId,
    openingId: opening.id,
    openingName: openingName(opening),
    userId: interaction.user.id,
    answers,
  });
  await postForReview(interaction.guild!, ctx.config, opening, application, interaction.user, files);
  await reply(
    interaction,
    ctx,
    t("applications.submittedTitle", "Application sent"),
    t("applications.submittedBody", "Thanks for applying for **{opening}**! The team will review it soon.", {
      opening: openingName(opening),
    }),
    "success",
    undefined,
    APPLICATION_EMOJIS.submitted,
  );
}

export async function handleApplicationModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(APPLICATION_PREFIX)) return false;
  const parsed = parseApplicationCustomId(interaction.customId);
  if (!parsed) return false;
  const ctx = await resolveContext(interaction);
  if (!ctx) return true;

  if (parsed.kind === "modal") {
    await handleFormPage(interaction, ctx, parsed.openingId, parsed.page);
    return true;
  }

  if (parsed.kind === "denymodal") {
    if (!(await hasPermission(interaction.guildId!, PLUGIN, "can_review", ctx.member, ctx.guildConfig))) {
      await reply(interaction, ctx, ctx.t("applications.noPermissionTitle", "No permission"), ctx.t("applications.noPermissionBody", "You don't have permission to review applications."), "error");
      return true;
    }
    const reason = interaction.fields.getTextInputValue(APPLICATION_REASON_FIELD_ID).trim() || null;
    await interaction.deferReply({ ephemeral: true });
    await finishDecision(interaction, ctx, parsed.applicationId, "denied", reason);
    return true;
  }
  return false;
}
