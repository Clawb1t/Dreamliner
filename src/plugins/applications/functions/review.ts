import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Attachment,
  type Guild,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type SendableChannels,
  type User,
} from "discord.js";
import {
  APPLICATION_EMOJIS,
  type ApplicationOpening,
  type ApplicationsConfig,
  type FormActions,
  type FormStatus,
} from "../../../config/schemas/applications.js";
import { baseEmbed, setEmbedAuthor, type ResultContainer } from "../../../core/embeds.js";
import { getLogger } from "../../../core/logger.js";
import { containerReply } from "../../../core/responses.js";
import { renderTemplate } from "../../../core/templates.js";
import { applicationAcceptId, applicationDenyId, formStatusSelectId } from "../constants.js";
import { FORM_KIND_NOUNS, findOpening, openingName, openingVars, reviewChannelFor } from "./config.js";
import { reviewModeOf, statusMeta, type StatusTone } from "./formLogic.js";
import {
  addApplicationEvent,
  changeStatus,
  decideApplication,
  getApplication,
  setReviewMessage,
  type ApplicationRecord,
} from "./store.js";
import { canManageRole } from "../../../core/roles.js";

const log = getLogger("applications");

const TONE_COLORS: Record<StatusTone, number> = {
  neutral: 0x8b95a1,
  note: 0x5865f2,
  ok: 0x22c55e,
  caution: 0xf59e0b,
  danger: 0xef4444,
};

function statusColor(app: ApplicationRecord, form?: ApplicationOpening): number {
  if (app.status === "pending") return TONE_COLORS.note;
  if (app.status === "accepted") return TONE_COLORS.ok;
  if (app.status === "denied") return TONE_COLORS.danger;
  return TONE_COLORS[statusMeta(form, app.status).tone];
}

/** Discord caps an embed at 6000 characters in total (kept a little under, for safety). */
const EMBED_CHAR_LIMIT = 5900;
const MAX_REVIEW_FILES = 10;

const RSVP_WORDS = { going: "Going", maybe: "Maybe", not_going: "Not going" } as const;

function statusLine(app: ApplicationRecord, form?: ApplicationOpening): string {
  if (app.status === "pending") return `${APPLICATION_EMOJIS.pending} Waiting for review`;
  const who = app.reviewerId ? ` by <@${app.reviewerId}>` : "";
  const when = app.decidedAt ? ` <t:${Math.floor(app.decidedAt.getTime() / 1000)}:R>` : "";
  let verdict: string;
  if (app.status === "accepted") verdict = `${APPLICATION_EMOJIS.accepted} Accepted${who}${when}`;
  else if (app.status === "denied") verdict = `${APPLICATION_EMOJIS.denied} Denied${who}${when}`;
  else if (app.status === "submitted") verdict = `${APPLICATION_EMOJIS.submitted} Received`;
  else verdict = `${statusMeta(form, app.status).label}${who}${when}`;
  return app.reason ? `${verdict}\n**Reason:** ${app.reason.slice(0, 800)}` : verdict;
}

function responseTitle(app: ApplicationRecord): string {
  const kind = app.formKind ?? "application";
  if (kind === "application") return `Application for ${app.openingName}`;
  return `${app.openingName} · new ${FORM_KIND_NOUNS[kind]}`;
}

export function buildReviewEmbed(app: ApplicationRecord, applicant: User | null, form?: ApplicationOpening): EmbedBuilder {
  const title = responseTitle(app).slice(0, 256);
  const anonymous = Boolean(app.anonymous);
  const footer = anonymous ? `Response #${app.id} · anonymous` : `${app.formKind && app.formKind !== "application" ? "Response" : "Application"} #${app.id} · ${app.userId}`;
  const who = anonymous
    ? "Anonymous response"
    : applicant
      ? `<@${applicant.id}> · account created <t:${Math.floor(applicant.createdTimestamp / 1000)}:R>`
      : `<@${app.userId}>`;
  const rsvp = app.rsvp ? `\n**RSVP:** ${RSVP_WORDS[app.rsvp]}${app.waitlisted ? " (waitlist)" : ""}` : "";
  const edited = app.updatedAt && !app.rsvp ? `\nEdited <t:${Math.floor(app.updatedAt.getTime() / 1000)}:R>` : "";
  const description = `${who}${rsvp}${edited}`;
  const status = statusLine(app, form);

  const embed = new EmbedBuilder()
    .setColor(statusColor(app, form))
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: footer })
    .setTimestamp(app.createdAt);
  if (applicant && !anonymous) embed.setAuthor({ name: applicant.tag, iconURL: applicant.displayAvatarURL({ size: 64 }) });

  // Answers share whatever the rest of the embed leaves of Discord's 6000-character total.
  const answers = app.answers.slice(0, 23);
  const fixedChars =
    title.length + description.length + footer.length + (applicant?.tag.length ?? 0) + "Status".length + status.length;
  const labelChars = answers.reduce((sum, a) => sum + Math.min(256, a.label.trim().length || 8), 0);
  const budget = EMBED_CHAR_LIMIT - fixedChars - labelChars;
  const perAnswer = Math.max(20, Math.min(1024, Math.floor(budget / Math.max(1, answers.length))));
  for (const answer of answers) {
    const text = answer.answer.trim();
    const value = !text ? "*No answer*" : text.length > perAnswer ? `${text.slice(0, perAnswer - 1)}…` : text;
    embed.addFields({ name: (answer.label.trim() || "Question").slice(0, 256), value });
  }
  embed.addFields({ name: "Status", value: status });
  return embed;
}

export function buildReviewButtons(app: ApplicationRecord): ActionRowBuilder<ButtonBuilder> {
  const decided = app.status !== "pending";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(applicationAcceptId(app.id))
      .setLabel(app.status === "accepted" ? "Accepted" : "Accept")
      .setEmoji(APPLICATION_EMOJIS.accepted)
      .setStyle(ButtonStyle.Success)
      .setDisabled(decided),
    new ButtonBuilder()
      .setCustomId(applicationDenyId(app.id))
      .setLabel(app.status === "denied" ? "Denied" : "Deny")
      .setEmoji(APPLICATION_EMOJIS.denied)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(decided),
  );
}

/** The status menu for custom review: "New" plus the server's own statuses. */
export function buildStatusSelect(app: ApplicationRecord, form: ApplicationOpening): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = [
    { label: "New", value: "pending", default: app.status === "pending" },
    ...form.statuses.map((s) => ({ label: s.label.slice(0, 100), value: s.id, default: app.status === s.id })),
  ].slice(0, 25);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(formStatusSelectId(app.id))
      .setPlaceholder("Set a status")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options),
  );
}

/** Review controls for a posted response, by the form's review mode. Old posts keep their buttons. */
export function buildReviewComponents(app: ApplicationRecord, form: ApplicationOpening | undefined): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const mode = form ? reviewModeOf(form) : "approve_deny";
  if (mode === "none" || app.status === "submitted") return [];
  if (mode === "custom" && form && form.statuses.length > 0) {
    return [buildStatusSelect(app, form) as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>];
  }
  return [buildReviewButtons(app) as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>];
}

/** The channel (or thread) a form's responses are posted in, or null when none is set or it's
 *  gone/unsendable. Checked before a member starts and before a response is saved. */
export async function resolveReviewChannel(
  guild: Guild,
  config: ApplicationsConfig,
  opening: ApplicationOpening,
): Promise<SendableChannels | null> {
  const channelId = reviewChannelFor(config, opening);
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  return channel as SendableChannels;
}

/** Whether responses to this form need a channel to go to. */
export function needsReviewChannel(opening: ApplicationOpening): boolean {
  return opening.post_submissions;
}

/** Posts a new response to its channel (re-uploading any attached files). */
export async function postForReview(
  guild: Guild,
  config: ApplicationsConfig,
  opening: ApplicationOpening,
  app: ApplicationRecord,
  applicant: User | null,
  files: Attachment[],
): Promise<boolean> {
  const channel = await resolveReviewChannel(guild, config, opening);
  if (!channel) return false;

  const pings = opening.ping_roles.map((id) => `<@&${id}>`).join(" ");
  const message = await channel
    .send({
      ...(pings ? { content: pings } : {}),
      embeds: [buildReviewEmbed(app, app.anonymous ? null : applicant, opening)],
      components: buildReviewComponents(app, opening),
      files: files.slice(0, MAX_REVIEW_FILES).map((file) => ({ attachment: file.url, name: file.name })),
      allowedMentions: { roles: opening.ping_roles },
    })
    .catch((error) => {
      log.error(`[applications] Failed to post response #${app.id} for review:`, error);
      return null;
    });
  if (!message) return false;

  let threadId: string | null = null;
  if (opening.review_thread && "startThread" in message) {
    // Fails harmlessly where threads aren't possible (e.g. the review channel is itself a thread).
    const name = app.anonymous ? `Response #${app.id}` : `${applicant?.username ?? app.userId} · ${openingName(opening)}`;
    const thread = await message.startThread({ name: name.slice(0, 100) }).catch(() => null);
    threadId = thread?.id ?? null;
  }
  setReviewMessage(app.id, { channelId: channel.id, messageId: message.id, threadId });
  return true;
}

/** Re-renders the posted response (status colour, verdict, controls), e.g. after a decision or an edit. */
export async function refreshReviewMessage(guild: Guild, app: ApplicationRecord, form?: ApplicationOpening, announce = true): Promise<void> {
  if (!app.reviewChannelId || !app.reviewMessageId) return;
  const channel = await guild.channels.fetch(app.reviewChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(app.reviewMessageId).catch(() => null);
  if (!message) return;
  const applicant = app.anonymous ? null : await guild.client.users.fetch(app.userId).catch(() => null);
  await message
    .edit({ embeds: [buildReviewEmbed(app, applicant, form)], components: buildReviewComponents(app, form) })
    .catch(() => null);

  if (announce && app.threadId) {
    const thread = await guild.channels.fetch(app.threadId).catch(() => null);
    if (thread?.isThread()) {
      await thread.send(containerReply(buildVerdictContainer(app, form))).catch(() => null);
    }
  }
}

/** The verdict posted into the response's discussion thread once it's decided. */
export function buildVerdictContainer(app: ApplicationRecord, form?: ApplicationOpening): ResultContainer {
  return baseEmbed().setColor(statusColor(app, form)).setDescription(statusLine(app, form));
}

export function renderFormText(
  template: string,
  guild: Guild,
  user: User | null,
  opening: ApplicationOpening,
  extra: Record<string, string> = {},
): string {
  return renderTemplate(template, { user, guild, extra: { ...openingVars(opening), ...extra } }).trim();
}

function renderDecisionMessage(
  template: string,
  guild: Guild,
  user: User,
  opening: ApplicationOpening,
  reason: string | null,
): string {
  const text = renderFormText(template, guild, user, opening, { reason: reason ?? "" });
  // Templates that don't place {reason} themselves still get it, on its own line.
  if (reason && !template.includes("{reason}")) return `${text}\n\n**Reason:** ${reason}`;
  return text;
}

/** The DM a member gets with an outcome: a titled container holding the server's message. */
export function buildDecisionDm(
  guild: Guild,
  decision: "accepted" | "denied" | { label: string; tone: StatusTone },
  opening: ApplicationOpening,
  text: string,
): ResultContainer {
  const application = opening.kind === "application";
  const noun = application ? "Application" : openingName(opening);
  const title =
    decision === "accepted" ? `${noun} accepted` : decision === "denied" ? `${noun} denied` : `${noun}: ${decision.label}`;
  const emoji = decision === "accepted" ? APPLICATION_EMOJIS.accepted : decision === "denied" ? APPLICATION_EMOJIS.denied : APPLICATION_EMOJIS.submitted;
  const color = decision === "accepted" ? TONE_COLORS.ok : decision === "denied" ? TONE_COLORS.danger : TONE_COLORS[decision.tone];
  const container = setEmbedAuthor(baseEmbed(), title.slice(0, 256), guild.client, { emoji, thumbnailURL: guild.iconURL({ size: 128 }) });
  return container
    .setColor(color)
    .setDescription(text.slice(0, 3000))
    .setFooter({ text: `${guild.name} · ${openingName(opening)}` });
}

/**
 * Gives and takes the roles an outcome lists. With a `reviewer`, only roles they could give by
 * hand (reviewing is no way around Manage Roles or the role hierarchy); without one (on submit),
 * the config-save check on these role fields already made sure whoever set them could give them.
 */
async function applyRoles(
  guild: Guild,
  member: GuildMember,
  add: string[],
  remove: string[],
  reasonText: string,
  reviewerId: string | null,
  notes: string[],
): Promise<void> {
  const reviewer = reviewerId ? await guild.members.fetch(reviewerId).catch(() => null) : null;
  const wanted = add.filter((id) => guild.roles.cache.has(id) && !member.roles.cache.has(id));
  const allowed = reviewerId ? wanted.filter((id) => reviewer && canManageRole(reviewer, guild.roles.cache.get(id)!)) : wanted;
  if (allowed.length < wanted.length) {
    notes.push("Some roles weren't given because they're above you or grant permissions you don't have. Someone who can give them should add them.");
  }
  // Removals aren't limited by the reviewer, exactly as accepting an application always worked.
  const removeAllowed = remove.filter((id) => member.roles.cache.has(id) && !allowed.includes(id));
  if (allowed.length > 0 && !(await member.roles.add(allowed, reasonText).then(() => true).catch(() => false))) {
    notes.push("Couldn't give the roles. Check that my role is above them and I have Manage Roles.");
  }
  if (removeAllowed.length > 0) await member.roles.remove(removeAllowed, reasonText).catch(() => null);
}

async function postAnnouncement(guild: Guild, channelId: string | undefined, text: string, notes: string[]): Promise<void> {
  if (!channelId || !text.trim()) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    notes.push("The announcement channel is missing, so nothing was posted.");
    return;
  }
  // User mentions are allowed (so {user} pings the member), role and everyone pings are not.
  const sent = await (channel as SendableChannels)
    .send({ content: text.slice(0, 2000), allowedMentions: { parse: ["users"] } })
    .catch(() => null);
  if (!sent) notes.push("Couldn't post the announcement. Check my permissions in that channel.");
}

/** What happens straight after a member submits: roles, a DM and an optional post. */
export async function runSubmitActions(
  guild: Guild,
  opening: ApplicationOpening,
  member: GuildMember,
  app: ApplicationRecord,
): Promise<string[]> {
  const notes: string[] = [];
  const actions: FormActions = opening.submit_actions;
  if (actions.add_roles.length || actions.remove_roles.length) {
    await applyRoles(guild, member, actions.add_roles, actions.remove_roles, `${openingName(opening)} response #${app.id}`, null, notes);
  }
  if (actions.dm_message.trim()) {
    const text = renderFormText(actions.dm_message, guild, member.user, opening);
    await member.user.send(containerReply(buildDecisionDm(guild, { label: "received", tone: "note" }, opening, text))).catch(() => null);
  }
  if (actions.post_message.trim()) {
    await postAnnouncement(guild, actions.post_channel_id, renderFormText(actions.post_message, guild, app.anonymous ? null : member.user, opening), notes);
  }
  return notes;
}

export type DecisionResult = { ok: true; application: ApplicationRecord; notes: string[] } | { ok: false; error: string };

/**
 * Accepts or denies a pending response: records it, hands out (or takes away) the form's roles,
 * DMs the member, posts any announcement, and updates the posted response. Shared by the review
 * buttons and the dashboard. `notes` lists anything that didn't fully go through.
 */
export async function decide(
  guild: Guild,
  config: ApplicationsConfig,
  applicationId: number,
  decision: "accepted" | "denied",
  reviewerId: string,
  reason: string | null,
): Promise<DecisionResult> {
  // Nobody decides their own response (a reviewer could otherwise accept themselves into roles).
  const pending = getApplication(guild.id, applicationId);
  if (pending && pending.userId === reviewerId) return { ok: false, error: "You can't review your own application." };
  const app = decideApplication(guild.id, applicationId, decision, reviewerId, reason?.trim() || null);
  if (!app) return { ok: false, error: "That response was already reviewed or doesn't exist." };

  const notes: string[] = [];
  const opening = findOpening(config, app.openingId);
  if (app.anonymous) {
    notes.push("This response is anonymous, so no roles or DMs could be sent.");
    await refreshReviewMessage(guild, app, opening);
    return { ok: true, application: app, notes };
  }
  const member = await guild.members.fetch(app.userId).catch(() => null);

  if (opening) {
    const add = decision === "accepted" ? opening.accept_roles : opening.deny_roles;
    const remove = decision === "accepted" ? opening.accept_remove_roles : opening.deny_remove_roles;
    if (add.length || remove.length) {
      if (!member) notes.push("The member has left the server, so no roles were changed.");
      else await applyRoles(guild, member, add, remove, `${opening.kind === "application" ? "Application" : "Response"} #${app.id} ${decision}`, reviewerId, notes);
    }
  }

  if (opening?.dm_decision) {
    const user = member?.user ?? (await guild.client.users.fetch(app.userId).catch(() => null));
    const template = decision === "accepted" ? opening.accept_message : opening.deny_message;
    if (user && template.trim()) {
      const text = renderDecisionMessage(template, guild, user, opening, app.reason);
      const sent = await user.send(containerReply(buildDecisionDm(guild, decision, opening, text))).catch(() => null);
      if (!sent) notes.push("The member has DMs closed, so they weren't notified.");
    }
  }

  if (opening && decision === "accepted" && opening.accept_post_message.trim()) {
    const user = member?.user ?? null;
    await postAnnouncement(guild, opening.accept_post_channel_id, renderFormText(opening.accept_post_message, guild, user, opening), notes);
  }

  await refreshReviewMessage(guild, app, opening);
  return { ok: true, application: app, notes };
}

/**
 * Custom review: moves a response to one of the form's statuses (or back to New) and runs that
 * status's roles and DM. Accepted/denied keep going through `decide`.
 */
export async function setResponseStatus(
  guild: Guild,
  config: ApplicationsConfig,
  applicationId: number,
  status: FormStatus,
  reviewerId: string,
  reason: string | null,
): Promise<DecisionResult> {
  const current = getApplication(guild.id, applicationId);
  if (!current) return { ok: false, error: "That response doesn't exist." };
  if (current.userId === reviewerId) return { ok: false, error: "You can't review your own response." };
  if (status === "accepted" || status === "denied") {
    if (current.status !== "pending") return { ok: false, error: "Only responses waiting for review can be accepted or denied." };
    return decide(guild, config, applicationId, status, reviewerId, reason);
  }
  const opening = findOpening(config, current.openingId);
  const def = opening?.statuses.find((s) => s.id === status);
  if (status !== "pending" && status !== "submitted" && !def) return { ok: false, error: "That status isn't part of this form any more." };
  const app = changeStatus(guild.id, applicationId, current.status, status, reviewerId, reason?.trim() || null);
  if (!app) return { ok: false, error: "That response already has this status, or someone changed it first." };
  addApplicationEvent({
    guildId: guild.id,
    applicationId,
    kind: "status",
    actorId: reviewerId,
    content: `${statusMeta(opening, current.status).label} → ${statusMeta(opening, status).label}`,
  });

  const notes: string[] = [];
  if (def && (def.add_roles.length || def.remove_roles.length || def.dm_message.trim())) {
    if (app.anonymous) notes.push("This response is anonymous, so no roles or DMs could be sent.");
    else {
      const member = await guild.members.fetch(app.userId).catch(() => null);
      if (member && (def.add_roles.length || def.remove_roles.length)) {
        await applyRoles(guild, member, def.add_roles, def.remove_roles, `Response #${app.id}: ${def.label}`, reviewerId, notes);
      } else if (!member && (def.add_roles.length || def.remove_roles.length)) {
        notes.push("The member has left the server, so no roles were changed.");
      }
      if (def.dm_message.trim() && opening) {
        const user = member?.user ?? (await guild.client.users.fetch(app.userId).catch(() => null));
        if (user) {
          const text = renderDecisionMessage(def.dm_message, guild, user, opening, app.reason);
          const sent = await user.send(containerReply(buildDecisionDm(guild, { label: def.label, tone: def.tone }, opening, text))).catch(() => null);
          if (!sent) notes.push("The member has DMs closed, so they weren't notified.");
        }
      }
    }
  }
  await refreshReviewMessage(guild, app, opening);
  return { ok: true, application: app, notes };
}
