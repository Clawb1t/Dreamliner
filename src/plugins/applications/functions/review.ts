import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Attachment,
  type Guild,
  type SendableChannels,
  type User,
} from "discord.js";
import type { ApplicationOpening, ApplicationStatus, ApplicationsConfig } from "../../../config/schemas/applications.js";
import { getLogger } from "../../../core/logger.js";
import { renderTemplate } from "../../../core/templates.js";
import { applicationAcceptId, applicationDenyId } from "../constants.js";
import { findOpening, openingName, openingVars, reviewChannelFor } from "./config.js";
import { decideApplication, setReviewMessage, type ApplicationRecord } from "./store.js";

const log = getLogger("applications");

const STATUS_COLORS: Record<ApplicationStatus, number> = {
  pending: 0x5865f2,
  accepted: 0x22c55e,
  denied: 0xef4444,
};

/** Discord caps an embed at 6000 characters in total (kept a little under, for safety). */
const EMBED_CHAR_LIMIT = 5900;
const MAX_REVIEW_FILES = 10;

function statusLine(app: ApplicationRecord): string {
  if (app.status === "pending") return "⏳ Waiting for review";
  const who = app.reviewerId ? ` by <@${app.reviewerId}>` : "";
  const when = app.decidedAt ? ` <t:${Math.floor(app.decidedAt.getTime() / 1000)}:R>` : "";
  const verdict = app.status === "accepted" ? `✅ Accepted${who}${when}` : `❌ Denied${who}${when}`;
  return app.reason ? `${verdict}\n**Reason:** ${app.reason.slice(0, 800)}` : verdict;
}

export function buildReviewEmbed(app: ApplicationRecord, applicant: User | null): EmbedBuilder {
  const title = `Application for ${app.openingName}`.slice(0, 256);
  const footer = `Application #${app.id} · ${app.userId}`;
  const description = applicant
    ? `<@${applicant.id}> · account created <t:${Math.floor(applicant.createdTimestamp / 1000)}:R>`
    : `<@${app.userId}>`;
  const status = statusLine(app);

  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS[app.status])
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: footer })
    .setTimestamp(app.createdAt);
  if (applicant) embed.setAuthor({ name: applicant.tag, iconURL: applicant.displayAvatarURL({ size: 64 }) });

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
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(decided),
    new ButtonBuilder()
      .setCustomId(applicationDenyId(app.id))
      .setLabel(app.status === "denied" ? "Denied" : "Deny")
      .setEmoji("✖️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(decided),
  );
}

/** Posts a new application to its review channel (re-uploading any attached files). */
export async function postForReview(
  guild: Guild,
  config: ApplicationsConfig,
  opening: ApplicationOpening,
  app: ApplicationRecord,
  applicant: User,
  files: Attachment[],
): Promise<boolean> {
  const channelId = reviewChannelFor(config, opening);
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return false;

  const pings = opening.ping_roles.map((id) => `<@&${id}>`).join(" ");
  const message = await (channel as SendableChannels)
    .send({
      ...(pings ? { content: pings } : {}),
      embeds: [buildReviewEmbed(app, applicant)],
      components: [buildReviewButtons(app)],
      files: files.slice(0, MAX_REVIEW_FILES).map((file) => ({ attachment: file.url, name: file.name })),
      allowedMentions: { roles: opening.ping_roles },
    })
    .catch((error) => {
      log.error(`[applications] Failed to post application #${app.id} for review:`, error);
      return null;
    });
  if (!message) return false;

  let threadId: string | null = null;
  if (opening.review_thread) {
    // Fails harmlessly where threads aren't possible (e.g. the review channel is itself a thread).
    const thread = await message
      .startThread({ name: `${applicant.username} · ${openingName(opening)}`.slice(0, 100) })
      .catch(() => null);
    threadId = thread?.id ?? null;
  }
  setReviewMessage(app.id, { channelId, messageId: message.id, threadId });
  return true;
}

/** Re-renders the review message after a decision (status colour, verdict, disabled buttons). */
async function refreshReviewMessage(guild: Guild, app: ApplicationRecord): Promise<void> {
  if (!app.reviewChannelId || !app.reviewMessageId) return;
  const channel = await guild.channels.fetch(app.reviewChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(app.reviewMessageId).catch(() => null);
  if (!message) return;
  const applicant = await guild.client.users.fetch(app.userId).catch(() => null);
  await message
    .edit({ embeds: [buildReviewEmbed(app, applicant)], components: [buildReviewButtons(app)] })
    .catch(() => null);

  if (app.threadId) {
    const thread = await guild.channels.fetch(app.threadId).catch(() => null);
    if (thread?.isThread()) {
      await thread.send({ content: statusLine(app), allowedMentions: { parse: [] } }).catch(() => null);
    }
  }
}

function renderDecisionMessage(
  template: string,
  guild: Guild,
  user: User,
  opening: ApplicationOpening,
  reason: string | null,
): string {
  const text = renderTemplate(template, {
    user,
    guild,
    extra: { ...openingVars(opening), reason: reason ?? "" },
  }).trim();
  // Templates that don't place {reason} themselves still get it, on its own line.
  if (reason && !template.includes("{reason}")) return `${text}\n\n**Reason:** ${reason}`;
  return text;
}

export type DecisionResult = { ok: true; application: ApplicationRecord; notes: string[] } | { ok: false; error: string };

/**
 * Accepts or denies a pending application: records it, hands out (or takes away) the opening's
 * roles, DMs the applicant, and updates the review message. Shared by the review buttons and the
 * dashboard. `notes` lists anything that didn't fully go through (e.g. DMs closed).
 */
export async function decide(
  guild: Guild,
  config: ApplicationsConfig,
  applicationId: number,
  decision: "accepted" | "denied",
  reviewerId: string,
  reason: string | null,
): Promise<DecisionResult> {
  const app = decideApplication(guild.id, applicationId, decision, reviewerId, reason?.trim() || null);
  if (!app) return { ok: false, error: "That application was already reviewed or doesn't exist." };

  const notes: string[] = [];
  const opening = findOpening(config, app.openingId);
  const member = await guild.members.fetch(app.userId).catch(() => null);

  if (decision === "accepted" && opening) {
    if (!member) {
      notes.push("The applicant has left the server, so no roles were given.");
    } else {
      const add = opening.accept_roles.filter((id) => guild.roles.cache.has(id) && !member.roles.cache.has(id));
      const remove = opening.accept_remove_roles.filter((id) => member.roles.cache.has(id) && !add.includes(id));
      const reasonText = `Application #${app.id} accepted`;
      if (add.length > 0 && !(await member.roles.add(add, reasonText).then(() => true).catch(() => false))) {
        notes.push("Couldn't give the roles. Check that my role is above them and I have Manage Roles.");
      }
      if (remove.length > 0) await member.roles.remove(remove, reasonText).catch(() => null);
    }
  }

  if (opening?.dm_decision) {
    const user = member?.user ?? (await guild.client.users.fetch(app.userId).catch(() => null));
    const template = decision === "accepted" ? opening.accept_message : opening.deny_message;
    if (user && template.trim()) {
      const sent = await user
        .send({ content: renderDecisionMessage(template, guild, user, opening, app.reason).slice(0, 2000) })
        .catch(() => null);
      if (!sent) notes.push("The applicant has DMs closed, so they weren't notified.");
    }
  }

  await refreshReviewMessage(guild, app);
  return { ok: true, application: app, notes };
}
