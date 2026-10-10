import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Guild,
  type MessageActionRowComponentBuilder,
  type SendableChannels,
  type User,
} from "discord.js";
import { APPEAL_EMOJIS, type AppealsConfig, type AppealStatus } from "../../../config/schemas/appeals.js";
import { getGuildAppealsDashboardUrl } from "../../../core/docsUrl.js";
import { baseEmbed, embedField, setEmbedAuthor, type ResultContainer } from "../../../core/embeds.js";
import { getLogger } from "../../../core/logger.js";
import { containerEdit, containerReply, pingComponent } from "../../../core/responses.js";
import { countUserInfractions } from "../../infraction/functions/infractions.js";
import { appealButtonId } from "../constants.js";
import { typeLabel } from "./config.js";
import { latestQuestion, listEvents, listUserAppeals, setReviewMessage, type AppealRecord } from "./store.js";

const log = getLogger("appeals");

export const STATUS_COLORS: Record<AppealStatus, number> = {
  pending: 0x5865f2,
  needs_info: 0xf0b232,
  approved: 0x22c55e,
  denied: 0xef4444,
  withdrawn: 0x6b7280,
};

/** Components V2 messages carry about 4000 characters of text in total; answers share what's left. */
const ANSWER_BUDGET = 2400;

const ts = (date: Date, style: "R" | "f" = "R") => `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;

/** "Ban (case #42)" or "Manual appeal": what this appeal is about. */
export function appealSubject(appeal: Pick<AppealRecord, "kind" | "caseId" | "infractionType">): string {
  if (appeal.kind === "manual") return appeal.infractionType === "ban" ? "Manual appeal (banned)" : "Manual appeal";
  return `${typeLabel(appeal.infractionType)} (case #${appeal.caseId})`;
}

function statusLine(appeal: AppealRecord): string {
  const who = appeal.reviewerId ? ` by <@${appeal.reviewerId}>` : "";
  const when = appeal.decidedAt ? ` ${ts(appeal.decidedAt)}` : "";
  switch (appeal.status) {
    case "pending":
      return `${APPEAL_EMOJIS.pending} Waiting for review`;
    case "needs_info":
      return `${APPEAL_EMOJIS.needsInfo} Waiting for the user to answer a question`;
    case "withdrawn":
      return "Withdrawn by the user";
    case "approved": {
      const lifted = appeal.reversalNote ? `\n${APPEAL_EMOJIS.lifted} ${appeal.reversalNote}` : "";
      const reason = appeal.decisionReason ? `\n**Note:** ${appeal.decisionReason.slice(0, 600)}` : "";
      return `${APPEAL_EMOJIS.approved} Approved${who}${when}${lifted}${reason}`;
    }
    case "denied": {
      const reason = appeal.decisionReason ? `\n**Reason:** ${appeal.decisionReason.slice(0, 600)}` : "";
      return `${APPEAL_EMOJIS.denied} Denied${who}${when}${reason}`;
    }
  }
}

export type ReviewContext = {
  otherInfractions: number;
  pastAppeals: AppealRecord[];
  /** The latest staff question and the user's latest reply, when there's been a back-and-forth. */
  question: string | null;
  reply: string | null;
};

export async function loadReviewContext(appeal: AppealRecord): Promise<ReviewContext> {
  const question = latestQuestion(appeal.id);
  const replies = listEvents(appeal.id, false).filter((event) => event.kind === "info_replied");
  return {
    otherInfractions: Math.max(0, (await countUserInfractions(appeal.guildId, appeal.userId).catch(() => 0)) - (appeal.caseId ? 1 : 0)),
    pastAppeals: listUserAppeals(appeal.guildId, appeal.userId).filter((item) => item.id !== appeal.id),
    question: question?.body ?? null,
    reply: replies.at(-1)?.body ?? null,
  };
}

export function buildAppealReview(
  guild: Guild,
  config: AppealsConfig,
  appeal: AppealRecord,
  user: User | null,
  context: ReviewContext,
): ResultContainer {
  const container = setEmbedAuthor(baseEmbed(), `Appeal #${appeal.id} · ${appealSubject(appeal)}`, guild.client, {
    emoji: APPEAL_EMOJIS.appeal,
    thumbnailURL: user?.displayAvatarURL({ size: 128 }) ?? null,
  }).setColor(STATUS_COLORS[appeal.status]);

  const lines = [
    user ? `<@${user.id}> · ${user.username} · account created ${ts(new Date(user.createdTimestamp))}` : `<@${appeal.userId}>`,
  ];
  const snapshot = appeal.caseSnapshot;
  if (snapshot) {
    lines.push(
      `**${typeLabel(snapshot.type)}** ${ts(new Date(snapshot.createdAt))} by <@${snapshot.modId}>` +
        (snapshot.expiresAt ? ` · ends ${ts(new Date(snapshot.expiresAt))}` : ""),
      `**Reason:** ${snapshot.reason?.trim() ? snapshot.reason.slice(0, 500) : "*none recorded*"}`,
    );
  } else if (appeal.kind === "manual") {
    lines.push("No infraction on file: the user chose a manual appeal.");
  }
  container.setDescription(lines.join("\n"));

  // Answers share a fixed budget so a long form never pushes the buttons off the message.
  const answers = appeal.answers.filter((answer) => answer.answer.trim());
  const perAnswer = Math.max(80, Math.floor(ANSWER_BUDGET / Math.max(1, answers.length)));
  container.addFields(
    answers.map((answer) => {
      const text = answer.answer.trim();
      return embedField(answer.label || "Question", text.length > perAnswer ? `${text.slice(0, perAnswer - 1)}…` : text);
    }),
  );

  if (context.question) {
    container.addFields(embedField(`${APPEAL_EMOJIS.needsInfo} Staff asked`, context.question.slice(0, 500)));
    if (context.reply) container.addFields(embedField("They replied", context.reply.slice(0, 800)));
  }

  if (config.review.show_history) {
    const past = context.pastAppeals;
    const summary = past.length
      ? past
          .slice(0, 5)
          .map((item) => `#${item.id} ${appealSubject(item)}: ${item.status.replace("_", " ")}`)
          .join("\n")
      : "No other appeals";
    container.addFields(
      embedField("History", `${context.otherInfractions} other infraction${context.otherInfractions === 1 ? "" : "s"} on file\n${summary}`),
    );
  }

  container.addFields(embedField("Status", statusLine(appeal)));
  return container.setFooter({ text: `Appeal #${appeal.id} · ${appeal.userId}` });
}

export function buildAppealButtons(guildId: string, appeal: AppealRecord): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const open = appeal.status === "pending" || appeal.status === "needs_info";
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(appealButtonId("approve", appeal.id))
      .setLabel(appeal.status === "approved" ? "Approved" : "Approve")
      .setEmoji(APPEAL_EMOJIS.approved)
      .setStyle(ButtonStyle.Success)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(appealButtonId("deny", appeal.id))
      .setLabel(appeal.status === "denied" ? "Denied" : "Deny")
      .setEmoji(APPEAL_EMOJIS.denied)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(appealButtonId("info", appeal.id))
      .setLabel("Needs info")
      .setEmoji(APPEAL_EMOJIS.needsInfo)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(appeal.status !== "pending"),
    // Staff notes stay open after a decision: reviewers often want to record why afterwards.
    new ButtonBuilder()
      .setCustomId(appealButtonId("note", appeal.id))
      .setLabel("Note")
      .setEmoji(APPEAL_EMOJIS.note)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel("Dashboard").setStyle(ButtonStyle.Link).setURL(getGuildAppealsDashboardUrl(guildId, appeal.id)),
  );
}

/** Posts a new appeal to the review channel (with role pings and an optional thread). */
export async function postAppealForReview(guild: Guild, config: AppealsConfig, appeal: AppealRecord, user: User | null): Promise<boolean> {
  const channelId = config.review.channel_id?.trim();
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return false;

  const payload = containerReply(
    buildAppealReview(guild, config, appeal, user, await loadReviewContext(appeal)),
    false,
    [buildAppealButtons(guild.id, appeal)],
  );
  const pings = config.review.ping_roles.map((id) => `<@&${id}>`).join(" ");
  const message = await (channel as SendableChannels)
    .send({
      ...payload,
      components: pings ? [pingComponent(pings), ...payload.components] : payload.components,
      allowedMentions: { roles: config.review.ping_roles },
    })
    .catch((error) => {
      log.error(`[appeals] Failed to post appeal #${appeal.id} for review:`, error);
      return null;
    });
  if (!message) return false;

  let threadId: string | null = null;
  if (config.review.thread) {
    // Fails harmlessly where threads aren't possible (e.g. the review channel is itself a thread).
    const thread = await message
      .startThread({ name: `Appeal #${appeal.id} · ${user?.username ?? appeal.userId}`.slice(0, 100) })
      .catch(() => null);
    threadId = thread?.id ?? null;
  }
  setReviewMessage(appeal.id, { channelId, messageId: message.id, threadId });
  return true;
}

/** Re-renders the review message, and posts `threadNote` into the appeal's thread when given. */
export async function refreshAppealReview(
  guild: Guild,
  config: AppealsConfig,
  appeal: AppealRecord,
  threadNote?: ResultContainer,
): Promise<void> {
  if (!appeal.reviewChannelId || !appeal.reviewMessageId) return;
  const channel = await guild.channels.fetch(appeal.reviewChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(appeal.reviewMessageId).catch(() => null);
  if (message) {
    const user = await guild.client.users.fetch(appeal.userId).catch(() => null);
    const container = buildAppealReview(guild, config, appeal, user, await loadReviewContext(appeal));
    const edit = containerEdit(container, [buildAppealButtons(guild.id, appeal)]);
    // Keep the role ping line the message was posted with.
    const ping = message.components[0]?.type === 10 ? [message.components[0].toJSON()] : [];
    await message.edit({ ...edit, components: [...ping, ...edit.components] }).catch(() => null);
  }
  if (threadNote && appeal.threadId) {
    const thread = await guild.channels.fetch(appeal.threadId).catch(() => null);
    if (thread?.isThread()) await thread.send(containerReply(threadNote)).catch(() => null);
  }
}
