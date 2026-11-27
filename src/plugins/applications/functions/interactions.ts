import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type ButtonInteraction,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  APPLICATION_EMOJIS,
  type ApplicationOpening,
  type ApplicationsConfig,
  type RsvpChoice,
} from "../../../config/schemas/applications.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import { buildFormModal, readFormAnswer, readFormFiles, type FormAnswer } from "../../../core/formModal.js";
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
  formRetryId,
  parseApplicationCustomId,
} from "../constants.js";
import { FORM_KIND_NOUNS, findOpening, loadApplicationsConfig, modalTitle, openingName, PLUGIN } from "./config.js";
import { clearDraft, getDraft, saveDraft, type ApplicationDraft } from "./drafts.js";
import { memberBlocker, startDecision } from "./eligibility.js";
import {
  estimatePageCount,
  finalizeAnswer,
  hasMorePages,
  initialStatus,
  isAnonymousForm,
  placeRsvp,
  planPage,
  promotionCount,
  summarizeQuestion,
  toModalQuestion,
  validateAnswer,
} from "./formLogic.js";
import { checkPassportRequirement } from "../../../core/verifiedOnly.js";
import { refreshOpeningPost } from "./post.js";
import { responderKey } from "./anonymous.js";
import {
  decide,
  needsReviewChannel,
  postForReview,
  refreshReviewMessage,
  renderFormText,
  resolveReviewChannel,
  runSubmitActions,
  setResponseStatus,
} from "./review.js";
import {
  addApplicationEvent,
  createApplication,
  getApplication,
  goingResponses,
  latestApplication,
  responsesForForm,
  rsvpCounts,
  setRsvp,
  updateAnswers,
  waitlist,
  type ApplicationRecord,
} from "./store.js";
import { containerReply } from "../../../core/responses.js";
import { baseEmbed, setEmbedAuthor } from "../../../core/embeds.js";

type Ctx = {
  t: Translator;
  guildConfig: GuildConfig;
  config: ApplicationsConfig;
  member: GuildMember;
};

type AnyInteraction = ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;

async function reply(
  interaction: AnyInteraction,
  ctx: Pick<Ctx, "guildConfig">,
  title: string,
  body: string,
  tone: EmbedTone,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
  emoji?: string,
): Promise<void> {
  const options = guildResultOptions(interaction.client, ctx.guildConfig, { tone, ...(emoji ? { emoji } : {}) });
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(resultEdit(title, body, options, components));
    return;
  }
  await interaction.reply(resultReply(title, body, true, options, components));
}

/** Resolves everything a handler needs, or replies with why it can't continue. */
async function resolveContext(interaction: AnyInteraction): Promise<Ctx | null> {
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply(t("applications.serverOnlyTitle", "Server only"), t("applications.useInServerBody", "Use this in a server."), true));
    return null;
  }
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, PLUGIN)) {
    await interaction.reply(
      resultReply(t("forms.disabledTitle", "Forms are off"), t("forms.disabledBody", "Forms are turned off for this server."), true),
    );
    return null;
  }
  return { t, guildConfig, config: loadApplicationsConfig(guildConfig), member: interaction.member as GuildMember };
}

function unavailable(interaction: AnyInteraction, ctx: Ctx): Promise<void> {
  return reply(interaction, ctx, ctx.t("applications.unavailableTitle", "Unavailable"), ctx.t("forms.unavailableBody", "This form is no longer available."), "error");
}

function expired(interaction: AnyInteraction, ctx: Ctx): Promise<void> {
  return reply(
    interaction,
    ctx,
    ctx.t("applications.expiredTitle", "Form expired"),
    ctx.t("forms.expiredBody", "Your progress on this form expired. Press the form's button to start again."),
    "warning",
  );
}

function notSetUp(interaction: AnyInteraction, ctx: Ctx, opening: ApplicationOpening): Promise<void> {
  return reply(
    interaction,
    ctx,
    ctx.t("applications.notSetUpTitle", "Not set up yet"),
    ctx.t("forms.notSetUpBody", "**{form}** isn't set up yet, so there's nowhere to send your answers. Let the server staff know.", {
      form: openingName(opening),
    }),
    "warning",
  );
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────

/** Text a member typed before, to fill back into a page (an edit, or a page that failed validation). */
function prefillFor(opening: ApplicationOpening, draft: ApplicationDraft, editing: ApplicationRecord | null, page: number) {
  const out = new Map<string, string>();
  if (editing) {
    for (const answer of editing.answers) out.set(answer.questionId, answer.answer);
  }
  if (draft.retry?.page === page) for (const [id, value] of Object.entries(draft.retry.values)) out.set(id, value);
  // Only plain text inputs can be filled in; choices and pickers start empty.
  const textIds = new Set(
    opening.questions
      .filter((q) => ["text", "number", "date", "time", "datetime"].includes(q.type))
      .map((q) => q.id),
  );
  for (const id of out.keys()) if (!textIds.has(id)) out.delete(id);
  return out;
}

function showPage(interaction: ButtonInteraction, opening: ApplicationOpening, draft: ApplicationDraft, page: number): Promise<void> {
  const cursor = draft.cursors?.[page] ?? 0;
  const plan = planPage(opening.questions, cursor, draft.answers);
  const questions = plan.indices.map((i) => opening.questions[i]!);
  const total = Math.max(page + 1, estimatePageCount(opening.questions, draft.answers, page, cursor));
  const title = total > 1 ? `${modalTitle(opening).slice(0, 36)} (${page + 1}/${total})` : modalTitle(opening);
  const editing = draft.editingId ? getApplication(interaction.guildId!, draft.editingId) : null;
  const prefill = prefillFor(opening, draft, editing, page);
  return interaction.showModal(
    buildFormModal({
      customId: applicationModalId(opening.id, page),
      title,
      questions: questions.map(toModalQuestion),
      fieldId: applicationFieldId,
      extras: (index) => {
        const q = questions[index];
        if (!q) return undefined;
        return { description: q.help, value: prefill.get(q.id) };
      },
    }),
  );
}

/**
 * Starts a form from its post's button: checks who can respond, decides whether this is a new
 * response or an edit of their open one, and shows the first page.
 */
async function startForm(interaction: ButtonInteraction, ctx: Ctx, opening: ApplicationOpening, rsvp: RsvpChoice | null = null): Promise<void> {
  const { t } = ctx;
  const decision = rsvp ? (() => {
    const blocked = memberBlocker(ctx.member, opening, t);
    return blocked ? { ok: false as const, message: blocked } : { ok: true as const, editing: latestApplication(interaction.guildId!, interaction.user.id, opening.id) };
  })() : startDecision(ctx.member, opening, t);
  if (!decision.ok) {
    await reply(interaction, ctx, t("forms.cantRespondTitle", "Can't respond"), decision.message, "warning");
    return;
  }
  const passport = await checkPassportRequirement(ctx.member, opening.require_passport, t);
  if (!passport.ok) {
    await reply(interaction, ctx, t("verifiedOnly.title", "Verified members only"), passport.message, "warning");
    return;
  }
  if (needsReviewChannel(opening) && !(await resolveReviewChannel(interaction.guild!, ctx.config, opening))) {
    await notSetUp(interaction, ctx, opening);
    return;
  }
  const draft: Omit<ApplicationDraft, "expiresAt"> = {
    answers: [],
    files: [],
    pagesDone: 0,
    cursors: [0],
    editingId: decision.editing?.id ?? null,
    rsvp,
    retry: null,
  };
  saveDraft(interaction.guildId!, interaction.user.id, opening.id, draft);
  await showPage(interaction, opening, { ...draft, expiresAt: 0 }, 0);
}

async function continueForm(interaction: ButtonInteraction, ctx: Ctx, opening: ApplicationOpening, page: number, retry: boolean): Promise<void> {
  const draft = getDraft(interaction.guildId!, interaction.user.id, opening.id);
  const expected = retry ? draft?.retry?.page : draft?.pagesDone;
  if (!draft || expected !== page) {
    await expired(interaction, ctx);
    return;
  }
  await showPage(interaction, opening, draft, page);
}

async function handleFormPage(interaction: ModalSubmitInteraction, ctx: Ctx, openingId: string, page: number): Promise<void> {
  const { t } = ctx;
  const guildId = interaction.guildId!;
  const opening = findOpening(ctx.config, openingId);
  if (!opening) {
    await unavailable(interaction, ctx);
    return;
  }

  // Page one opened from a post made before drafts held state still works without one.
  const stored = getDraft(guildId, interaction.user.id, opening.id);
  const draft: Omit<ApplicationDraft, "expiresAt"> | null =
    stored ?? (page === 0 ? { answers: [], files: [], pagesDone: 0, cursors: [0], editingId: null, rsvp: null, retry: null } : null);
  if (!draft || draft.pagesDone !== page) {
    await expired(interaction, ctx);
    return;
  }

  const cursor = draft.cursors?.[page] ?? 0;
  const plan = planPage(opening.questions, cursor, draft.answers);
  if (plan.indices.length === 0) {
    await unavailable(interaction, ctx);
    return;
  }

  const pageAnswers: FormAnswer[] = [];
  const files: Attachment[] = [];
  const typed: Record<string, string> = {};
  const errors: string[] = [];
  for (const [index, questionIndex] of plan.indices.entries()) {
    const question = opening.questions[questionIndex]!;
    const modalQuestion = toModalQuestion(question);
    const raw = readFormAnswer(modalQuestion, applicationFieldId(index), interaction.fields);
    files.push(...readFormFiles(modalQuestion, applicationFieldId(index), interaction.fields));
    if (!raw) continue;
    const answer = finalizeAnswer(question, raw);
    if (modalQuestion.type === "text") typed[question.id] = raw.answer;
    const problem = validateAnswer(question, answer);
    if (problem) errors.push(problem);
    pageAnswers.push(answer);
  }

  if (errors.length > 0) {
    saveDraft(guildId, interaction.user.id, opening.id, { ...draft, retry: { page, values: typed, errors } });
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(formRetryId(opening.id, page))
        .setLabel(t("forms.fixButton", "Fix answers"))
        .setEmoji(APPLICATION_EMOJIS.next)
        .setStyle(ButtonStyle.Primary),
    );
    await reply(interaction, ctx, t("forms.fixTitle", "A few answers need another look"), errors.slice(0, 10).join("\n"), "warning", [row]);
    return;
  }

  const shown = new Set(plan.indices.map((i) => opening.questions[i]!.id));
  const answers = [...draft.answers.filter((a) => !shown.has(a.questionId)), ...pageAnswers];
  const allFiles = [...draft.files, ...files];

  // More pages to go: park what we have and hand the member a button to open the next one.
  if (hasMorePages(opening.questions, plan.next, answers)) {
    const cursors = [...(draft.cursors ?? [0])];
    cursors[page + 1] = plan.next;
    saveDraft(guildId, interaction.user.id, opening.id, { ...draft, answers, files: allFiles, pagesDone: page + 1, cursors, retry: null });
    const total = Math.max(page + 2, estimatePageCount(opening.questions, answers, page + 1, plan.next));
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(applicationContinueId(opening.id, page + 1))
        .setLabel(t("applications.continueButton", "Continue ({page}/{total})", { page: page + 2, total }))
        .setEmoji(APPLICATION_EMOJIS.next)
        .setStyle(ButtonStyle.Primary),
    );
    await reply(
      interaction,
      ctx,
      t("applications.pageSavedTitle", "Page {page} of {total} saved", { page: page + 1, total }),
      t("forms.pageSavedBody", "Press **Continue** for the next page of **{form}**.", { form: openingName(opening) }),
      "neutral",
      [row],
      APPLICATION_EMOJIS.pageSaved,
    );
    return;
  }

  // Answers in the form's own question order, whatever order the pages came in.
  const order = new Map(opening.questions.map((q, i) => [q.id, i]));
  answers.sort((a, b) => (order.get(a.questionId) ?? 99) - (order.get(b.questionId) ?? 99));
  clearDraft(guildId, interaction.user.id, opening.id);

  if (opening.kind === "rsvp" && draft.rsvp) {
    await interaction.deferReply({ ephemeral: true });
    await commitRsvp(interaction, ctx, opening, draft.rsvp, answers, allFiles);
    return;
  }

  // Checked again at submit: another response may have landed while this one was being filled in.
  const editing = draft.editingId ? getApplication(guildId, draft.editingId) : null;
  if (!editing) {
    const decision = startDecision(ctx.member, opening, t);
    if (!decision.ok) {
      await reply(interaction, ctx, t("forms.cantRespondTitle", "Can't respond"), decision.message, "warning");
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });
  if (editing) {
    const updated = updateAnswers(guildId, editing.id, answers);
    if (updated) {
      addApplicationEvent({ guildId, applicationId: editing.id, kind: "edit", actorId: null, content: "The member edited their answers." });
      await refreshReviewMessage(interaction.guild!, updated, opening, false);
    }
    await reply(
      interaction,
      ctx,
      t("forms.editedTitle", "Answers updated"),
      t("forms.editedBody", "Your answers to **{form}** were updated.", { form: openingName(opening) }),
      "success",
      undefined,
      APPLICATION_EMOJIS.submitted,
    );
    return;
  }

  // Checked before saving, so a missing channel doesn't leave a response nobody can see.
  // The draft is kept so the member can resubmit the last page once staff fix it.
  if (needsReviewChannel(opening) && !(await resolveReviewChannel(interaction.guild!, ctx.config, opening))) {
    saveDraft(guildId, interaction.user.id, opening.id, { ...draft, retry: null });
    await notSetUp(interaction, ctx, opening);
    return;
  }

  const anonymous = isAnonymousForm(opening);
  const application = createApplication({
    guildId,
    openingId: opening.id,
    openingName: openingName(opening),
    userId: responderKey(interaction.user.id, anonymous),
    answers,
    status: initialStatus(opening),
    formKind: opening.kind,
    anonymous,
  });
  const posted = needsReviewChannel(opening)
    ? await postForReview(interaction.guild!, ctx.config, opening, application, interaction.user, allFiles)
    : true;
  await runSubmitActions(interaction.guild!, opening, ctx.member, application).catch(() => []);
  if (!posted) {
    await reply(
      interaction,
      ctx,
      t("forms.notPostedTitle", "Saved, not delivered"),
      t("forms.notPostedBody", "Your answers to **{form}** were saved, but they couldn't be posted for the team. Let the server staff know.", {
        form: openingName(opening),
      }),
      "warning",
    );
    return;
  }
  await reply(interaction, ctx, ...submittedCopy(interaction, ctx, opening), "success", undefined, APPLICATION_EMOJIS.submitted);
}

function submittedCopy(interaction: AnyInteraction, ctx: Ctx, opening: ApplicationOpening): [string, string] {
  const { t } = ctx;
  const custom = opening.confirmation_message.trim()
    ? renderFormText(opening.confirmation_message, interaction.guild!, interaction.user, opening)
    : "";
  const results = opening.show_results ? resultsText(interaction.guildId!, opening) : "";
  if (opening.kind === "application") {
    const body = custom || t("applications.submittedBody", "Thanks for applying for **{opening}**. The team will review it soon.", { opening: openingName(opening) });
    return [t("applications.submittedTitle", "Application sent"), [body, results].filter(Boolean).join("\n\n")];
  }
  const body = custom || t("forms.submittedBody", "Thanks, your answers to **{form}** were sent.", { form: openingName(opening) });
  return [t("forms.submittedTitle", "Sent"), [body, results].filter(Boolean).join("\n\n")];
}

/** Text bars for each choice question, for "show results after responding". */
export function resultsText(guildId: string, opening: ApplicationOpening): string {
  const responses = responsesForForm(guildId, opening.id, 2000).map((r) => r.answers);
  const blocks: string[] = [];
  for (const question of opening.questions) {
    const summary = summarizeQuestion(question, responses, 0);
    if (!summary.choices?.length) continue;
    const total = summary.choices.reduce((sum, c) => sum + c.count, 0) || 1;
    const lines = summary.choices.slice(0, 10).map((c) => {
      const share = c.count / total;
      const filled = Math.round(share * 10);
      return `\`${"█".repeat(filled)}${"░".repeat(10 - filled)}\` ${Math.round(share * 100)}% ${c.label} (${c.count})`;
    });
    blocks.push(`**${question.label}**\n${lines.join("\n")}`);
    if (blocks.length >= 4) break;
  }
  return blocks.length ? `**Results so far**\n${blocks.join("\n\n")}`.slice(0, 3500) : "";
}

// ── RSVP ─────────────────────────────────────────────────────────────────────────────────────

const RSVP_TITLES: Record<RsvpChoice, string> = { going: "You're going", maybe: "Marked as maybe", not_going: "Marked as not going" };

async function handleRsvpButton(interaction: ButtonInteraction, ctx: Ctx, opening: ApplicationOpening, choice: RsvpChoice): Promise<void> {
  const { t } = ctx;
  if (opening.kind !== "rsvp") {
    await unavailable(interaction, ctx);
    return;
  }
  const blocked = memberBlocker(ctx.member, opening, t);
  if (blocked) {
    await reply(interaction, ctx, t("forms.cantRespondTitle", "Can't respond"), blocked, "warning");
    return;
  }
  const now = Date.now();
  const opensAt = Date.parse(opening.opens_at ?? "");
  const closesAt = Date.parse(opening.closes_at ?? "");
  if ((Number.isFinite(opensAt) && now < opensAt) || (Number.isFinite(closesAt) && now >= closesAt)) {
    await reply(interaction, ctx, t("forms.cantRespondTitle", "Can't respond"), t("forms.rsvpClosedBody", "RSVPs for **{form}** are closed.", { form: openingName(opening) }), "warning");
    return;
  }
  const existing = latestApplication(interaction.guildId!, interaction.user.id, opening.id);
  // Questions are asked once, the first time someone says they're coming.
  if (choice !== "not_going" && opening.questions.length > 0 && (!existing || existing.answers.length === 0)) {
    await startForm(interaction, ctx, opening, choice);
    return;
  }
  if (choice !== "not_going") {
    const passport = await checkPassportRequirement(ctx.member, opening.require_passport, t);
    if (!passport.ok) {
      await reply(interaction, ctx, t("verifiedOnly.title", "Verified members only"), passport.message, "warning");
      return;
    }
  }
  await interaction.deferReply({ ephemeral: true });
  await commitRsvp(interaction, ctx, opening, choice, existing?.answers ?? [], []);
}

/**
 * Saves an RSVP: places the member (going, waitlist or turned away when full), keeps one
 * response per member, moves people up from the waitlist when a spot frees, gives or takes the
 * going roles and refreshes the post's counts. The count and the write happen with no await in
 * between, so two people clicking at once can't both take the last spot.
 */
async function commitRsvp(
  interaction: AnyInteraction,
  ctx: Ctx,
  opening: ApplicationOpening,
  choice: RsvpChoice,
  answers: FormAnswer[],
  files: Attachment[],
): Promise<void> {
  const { t } = ctx;
  const guild = interaction.guild!;
  const guildId = guild.id;
  const existing = latestApplication(guildId, interaction.user.id, opening.id);
  const counts = rsvpCounts(guildId, opening.id);
  const placed = placeRsvp(opening, counts.going, existing?.rsvp ? { rsvp: existing.rsvp, waitlisted: Boolean(existing.waitlisted) } : null, choice);
  if ("error" in placed) {
    await reply(
      interaction,
      ctx,
      t("forms.rsvpFullTitle", "Full"),
      placed.error === "full"
        ? t("forms.rsvpFullBody", "**{form}** is full.", { form: openingName(opening) })
        : t("forms.rsvpMaybeOffBody", "This event doesn't take maybes."),
      "warning",
    );
    return;
  }
  const wasConfirmed = existing?.rsvp === "going" && !existing.waitlisted;
  const anonymous = isAnonymousForm(opening);
  let record: ApplicationRecord | null;
  let created = false;
  if (existing) {
    record = setRsvp(guildId, existing.id, placed.rsvp, placed.waitlisted);
    if (record && answers.length && existing.answers.length === 0) record = updateAnswers(guildId, existing.id, answers) ?? record;
  } else {
    record = createApplication({
      guildId,
      openingId: opening.id,
      openingName: openingName(opening),
      userId: responderKey(interaction.user.id, anonymous),
      answers,
      status: initialStatus(opening),
      formKind: "rsvp",
      anonymous,
      rsvp: placed.rsvp,
      waitlisted: placed.waitlisted,
    });
    created = true;
  }
  if (!record) {
    await unavailable(interaction, ctx);
    return;
  }
  if (existing && existing.rsvp !== placed.rsvp) {
    addApplicationEvent({ guildId, applicationId: record.id, kind: "rsvp", actorId: null, content: `${existing.rsvp ?? "none"} → ${placed.rsvp}${placed.waitlisted ? " (waitlist)" : ""}` });
  }

  const nowConfirmed = placed.rsvp === "going" && !placed.waitlisted;
  const roles = opening.event.going_roles.filter((id) => guild.roles.cache.has(id));
  if (roles.length && nowConfirmed !== wasConfirmed) {
    if (nowConfirmed) await ctx.member.roles.add(roles, `${openingName(opening)} RSVP`).catch(() => null);
    else await ctx.member.roles.remove(roles, `${openingName(opening)} RSVP`).catch(() => null);
  }
  if (wasConfirmed && !nowConfirmed) await promoteFromWaitlist(guild, opening);

  if (created) {
    if (needsReviewChannel(opening)) await postForReview(guild, ctx.config, opening, record, interaction.user, files);
    await runSubmitActions(guild, opening, ctx.member, record).catch(() => []);
  } else {
    await refreshReviewMessage(guild, record, opening, false);
  }
  await refreshOpeningPost(guild, opening);

  const name = openingName(opening);
  let body: string;
  if (placed.waitlisted) {
    const position = waitlist(guildId, opening.id).findIndex((r) => r.id === record!.id) + 1;
    body = t("forms.rsvpWaitlistBody", "**{form}** is full, so you're on the waitlist (number {position}). You'll get a DM if a spot opens.", {
      form: name,
      position: Math.max(1, position),
    });
  } else if (placed.rsvp === "going") {
    const custom = opening.confirmation_message.trim() ? renderFormText(opening.confirmation_message, guild, interaction.user, opening) : "";
    body = custom || t("forms.rsvpGoingBody", "See you at **{form}**.", { form: name });
  } else if (placed.rsvp === "maybe") {
    body = t("forms.rsvpMaybeBody", "You're down as a maybe for **{form}**.", { form: name });
  } else {
    body = t("forms.rsvpNotGoingBody", "Thanks for letting us know. You can change your answer any time.");
  }
  await reply(
    interaction,
    ctx,
    placed.waitlisted ? t("forms.rsvpWaitlistTitle", "On the waitlist") : t(`forms.rsvp_${placed.rsvp}`, RSVP_TITLES[placed.rsvp]),
    body,
    placed.rsvp === "going" && !placed.waitlisted ? "success" : "neutral",
    undefined,
    APPLICATION_EMOJIS.submitted,
  );
}

/** Moves waitlisted members up into free spots, in the order they joined, and DMs them. */
export async function promoteFromWaitlist(guild: import("discord.js").Guild, opening: ApplicationOpening): Promise<number> {
  const counts = rsvpCounts(guild.id, opening.id);
  const n = promotionCount(opening.event.capacity, counts.going, counts.waitlisted);
  if (n <= 0) return 0;
  const moved = waitlist(guild.id, opening.id, n).map((r) => setRsvp(guild.id, r.id, "going", false)).filter((r): r is ApplicationRecord => Boolean(r));
  const roles = opening.event.going_roles.filter((id) => guild.roles.cache.has(id));
  for (const record of moved) {
    addApplicationEvent({ guildId: guild.id, applicationId: record.id, kind: "rsvp", actorId: null, content: "Moved up from the waitlist." });
    if (record.anonymous) continue;
    const member = await guild.members.fetch(record.userId).catch(() => null);
    if (member && roles.length) await member.roles.add(roles, `${openingName(opening)} RSVP`).catch(() => null);
    const container = setEmbedAuthor(baseEmbed(), "A spot opened up", guild.client, {
      emoji: APPLICATION_EMOJIS.celebrate,
      thumbnailURL: guild.iconURL({ size: 128 }),
    })
      .setDescription(`You're off the waitlist and going to **${openingName(opening)}** in **${guild.name}**.`)
      .setFooter({ text: guild.name });
    await member?.user.send(containerReply(container)).catch(() => null);
  }
  return moved.length;
}

async function handleAttendees(interaction: ButtonInteraction, ctx: Ctx, opening: ApplicationOpening): Promise<void> {
  const { t } = ctx;
  const counts = rsvpCounts(interaction.guildId!, opening.id);
  const going = goingResponses(interaction.guildId!, opening.id, 60).filter((r) => !r.anonymous);
  const names = going.slice(0, 50).map((r) => `<@${r.userId}>`);
  const more = counts.going - names.length;
  const body = [
    names.length ? names.join(" ") : t("forms.nobodyYet", "Nobody has said they're going yet."),
    more > 0 ? t("forms.andMore", "and {count} more", { count: more }) : "",
    counts.waitlisted ? t("forms.waitlistCount", "{count} on the waitlist", { count: counts.waitlisted }) : "",
  ]
    .filter(Boolean)
    .join("\n");
  await reply(interaction, ctx, t("forms.whoTitle", "Who's going to {form}", { form: openingName(opening) }), body, "neutral");
}

// ── Review ───────────────────────────────────────────────────────────────────────────────────

async function canReview(interaction: AnyInteraction, ctx: Ctx): Promise<boolean> {
  if (await hasPermission(interaction.guildId!, PLUGIN, "can_review", ctx.member, ctx.guildConfig)) return true;
  await reply(
    interaction,
    ctx,
    ctx.t("applications.noPermissionTitle", "No permission"),
    ctx.t("forms.noPermissionBody", "You don't have permission to review responses."),
    "error",
  );
  return false;
}

async function handleReviewButton(interaction: ButtonInteraction, ctx: Ctx, applicationId: number, kind: "accept" | "deny"): Promise<void> {
  const { t } = ctx;
  if (!(await canReview(interaction, ctx))) return;

  if (kind === "deny") {
    const modal = new ModalBuilder()
      .setCustomId(applicationDenyModalId(applicationId))
      .setTitle(t("forms.denyModalTitle", "Deny response"))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(APPLICATION_REASON_FIELD_ID)
            .setLabel(t("forms.reasonLabel", "Reason (optional, sent to the member)"))
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
  interaction: AnyInteraction,
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
  const application = result.application.formKind === "application" || !result.application.formKind;
  const title = application
    ? decision === "accepted"
      ? t("applications.acceptedTitle", "Application accepted")
      : t("applications.deniedTitle", "Application denied")
    : decision === "accepted"
      ? t("forms.acceptedTitle", "Response accepted")
      : t("forms.deniedTitle", "Response denied");
  const who = result.application.anonymous ? t("forms.anonymous", "an anonymous member") : `<@${result.application.userId}>`;
  const body = [
    t("forms.decisionBody", "{noun} **#{id}** from {who} was {decision}.", {
      noun: application ? "Application" : "Response",
      id: result.application.id,
      who,
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

  if (parsed.kind === "accept" || parsed.kind === "deny") {
    await handleReviewButton(interaction, ctx, parsed.applicationId, parsed.kind);
    return true;
  }
  if (parsed.kind === "apply" || parsed.kind === "next" || parsed.kind === "retry" || parsed.kind === "rsvp" || parsed.kind === "who") {
    const opening = findOpening(ctx.config, parsed.openingId);
    if (!opening) {
      await unavailable(interaction, ctx);
      return true;
    }
    if (parsed.kind === "apply") {
      // An RSVP post's main button is Going (older posts or a changed kind still land here).
      if (opening.kind === "rsvp") await handleRsvpButton(interaction, ctx, opening, "going");
      else await startForm(interaction, ctx, opening);
    } else if (parsed.kind === "next") await continueForm(interaction, ctx, opening, parsed.page, false);
    else if (parsed.kind === "retry") await continueForm(interaction, ctx, opening, parsed.page, true);
    else if (parsed.kind === "rsvp") await handleRsvpButton(interaction, ctx, opening, parsed.choice);
    else await handleAttendees(interaction, ctx, opening);
    return true;
  }
  return false;
}

/** The status menu on a response posted for custom review. */
export async function handleApplicationSelectMenu(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const parsed = parseApplicationCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "status") return false;
  const ctx = await resolveContext(interaction);
  if (!ctx) return true;
  if (!(await canReview(interaction, ctx))) return true;
  const status = interaction.values[0] ?? "pending";
  await interaction.deferReply({ ephemeral: true });
  const result = await setResponseStatus(interaction.guild!, ctx.config, parsed.applicationId, status, interaction.user.id, null);
  if (!result.ok) {
    await reply(interaction, ctx, ctx.t("forms.statusNotChangedTitle", "Status not changed"), result.error, "warning");
    // The menu shows the pick even though it didn't apply, so put it back.
    const app = getApplication(interaction.guildId!, parsed.applicationId);
    if (app) await refreshReviewMessage(interaction.guild!, app, findOpening(ctx.config, app.openingId), false);
    return true;
  }
  const opening = findOpening(ctx.config, result.application.openingId);
  const label = opening?.statuses.find((s) => s.id === status)?.label ?? (status === "pending" ? "New" : status);
  await reply(
    interaction,
    ctx,
    ctx.t("forms.statusChangedTitle", "Status changed"),
    [ctx.t("forms.statusChangedBody", "Response **#{id}** is now **{status}**.", { id: result.application.id, status: label }), ...result.notes].join("\n"),
    "success",
  );
  return true;
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
    if (!(await canReview(interaction, ctx))) return true;
    const reason = interaction.fields.getTextInputValue(APPLICATION_REASON_FIELD_ID).trim() || null;
    await interaction.deferReply({ ephemeral: true });
    await finishDecision(interaction, ctx, parsed.applicationId, "denied", reason);
    return true;
  }
  return false;
}

export { FORM_KIND_NOUNS };
