import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type MessageActionRowComponentBuilder,
  type User,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import { APPEAL_EMOJIS, type AppealsConfig } from "../../../config/schemas/appeals.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getAppealStatusUrl, getGuildAppealsDashboardUrl } from "../../../core/docsUrl.js";
import { baseEmbed, setEmbedAuthor, type ResultContainer } from "../../../core/embeds.js";
import { buildAppealLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { containerReply } from "../../../core/responses.js";
import { renderTemplate } from "../../../core/templates.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { isDashboardSuperuser } from "../../../bridge/superuser.js";
import { getDb } from "../../../db/client.js";
import { modCases } from "../../../db/schema.js";
import { formById, typeLabel } from "./config.js";
import { appealOptions, snowflakeDate, type AppealOptions, type CaseLike } from "./eligibility.js";
import { reversePunishment } from "./reverse.js";
import { appealSubject, postAppealForReview, refreshAppealReview, STATUS_COLORS } from "./review.js";
import {
  addEvent,
  createAppeal,
  getAppeal,
  listUserAppeals,
  OPEN_STATUSES,
  setReversal,
  transitionAppeal,
  type AppealRecord,
} from "./store.js";
import { validateAppealAnswers, type RawAnswer } from "./validate.js";

// ---------------------------------------------------------------------------------------------
// The appellant's situation
// ---------------------------------------------------------------------------------------------

/** Every infraction on file for a user in a server, newest first (only the appealable kinds). */
export function listUserCases(guildId: string, userId: string): CaseLike[] {
  return getDb()
    .select()
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.userId, userId)))
    .orderBy(desc(modCases.id))
    .limit(100)
    .all()
    .map((row) => ({
      id: row.id,
      type: row.type,
      reason: row.reason,
      modId: row.modId,
      active: row.active,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt ?? null,
    }));
}

export type ViewerSituation = {
  options: AppealOptions;
  cases: CaseLike[];
  appeals: AppealRecord[];
  isBanned: boolean;
  isMember: boolean;
};

/** What a user can appeal in a server right now: their cases, past appeals and eligibility. */
export async function viewerSituation(guild: Guild, config: AppealsConfig, userId: string): Promise<ViewerSituation> {
  const [ban, member] = await Promise.all([
    guild.bans.fetch({ user: userId, force: true }).catch(() => null),
    guild.members.fetch(userId).catch(() => null),
  ]);
  const cases = listUserCases(guild.id, userId);
  const appeals = listUserAppeals(guild.id, userId);
  const options = appealOptions(config, cases, appeals, new Date(), {
    userId,
    isBanned: Boolean(ban),
    isMember: Boolean(member),
    accountCreatedAt: snowflakeDate(userId),
    memberRoleIds: member ? [...member.roles.cache.keys()] : [],
  });
  return { options, cases, appeals, isBanned: Boolean(ban), isMember: Boolean(member) };
}

// ---------------------------------------------------------------------------------------------
// Logs, DMs, thread notes
// ---------------------------------------------------------------------------------------------

async function logAppeal(
  client: Client,
  guildConfig: GuildConfig,
  appeal: AppealRecord,
  eventType: "appeal_submitted" | "appeal_approved" | "appeal_denied" | "appeal_info" | "appeal_reversal_failed",
  title: string,
  extra: { actorId?: string | null; reason?: string | null; note?: string | null } = {},
): Promise<void> {
  const user = await client.users.fetch(appeal.userId).catch(() => null);
  const actor = extra.actorId ? await client.users.fetch(extra.actorId).catch(() => null) : null;
  await sendModerationLog(
    client,
    guildConfig,
    buildAppealLog({
      title,
      appealId: appeal.id,
      user: { id: appeal.userId, name: user?.username, avatarUrl: user?.displayAvatarURL({ size: 128 }) },
      actor: extra.actorId ? { id: extra.actorId, name: actor?.username } : null,
      subject: appealSubject(appeal),
      reason: extra.reason,
      note: extra.note,
      url: getGuildAppealsDashboardUrl(appeal.guildId, appeal.id),
    }),
    {
      guildId: appeal.guildId,
      eventType,
      actorId: extra.actorId ?? undefined,
      targetId: appeal.userId,
      caseId: appeal.caseId ?? undefined,
    },
  ).catch(() => null);
}

function dmText(
  template: string,
  guild: Guild,
  user: User,
  appeal: AppealRecord,
  vars: { reason?: string | null; lifted?: string; reasonLabel: "Reason" | "Note" | "Question" },
) {
  const reason = vars.reason?.trim() ?? "";
  const text = renderTemplate(template, {
    user,
    guild,
    extra: {
      case: appeal.caseId ? `#${appeal.caseId}` : "",
      type: typeLabel(appeal.infractionType),
      reason,
      lifted: vars.lifted ?? "",
      link: getAppealStatusUrl(guild.id, appeal.id),
    },
  }).trim();
  // Templates that don't place {reason} themselves still get it, on its own line.
  return reason && !template.includes("{reason}") ? `${text}\n\n**${vars.reasonLabel}:** ${reason}` : text;
}

/** First text channel the bot can make an invite for: the configured one, else the system channel. */
async function createRejoinInvite(guild: Guild, config: AppealsConfig, appealId: number): Promise<string | null> {
  const me = guild.members.me;
  const candidates = [
    config.decisions.invite_channel_id?.trim() ? await guild.channels.fetch(config.decisions.invite_channel_id).catch(() => null) : null,
    guild.systemChannel,
    guild.rulesChannel,
    ...guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildText).values(),
  ];
  for (const channel of candidates) {
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite)) continue;
    const invite = await channel
      .createInvite({ maxUses: 1, maxAge: 86_400, unique: true, reason: `Appeal #${appealId} approved` })
      .catch(() => null);
    if (invite) return invite.url;
  }
  return null;
}

/** DMs the user about their appeal: a titled container plus a link to their appeal page. */
async function dmAppellant(
  guild: Guild,
  appeal: AppealRecord,
  title: string,
  emoji: string,
  text: string,
  extraButton?: { label: string; url: string },
): Promise<boolean> {
  const user = await guild.client.users.fetch(appeal.userId).catch(() => null);
  if (!user || !text.trim()) return false;
  const container = setEmbedAuthor(baseEmbed(), title, guild.client, { emoji, thumbnailURL: guild.iconURL({ size: 128 }) })
    .setColor(STATUS_COLORS[appeal.status])
    .setDescription(text.slice(0, 3000))
    .setFooter({ text: `${guild.name} · Appeal #${appeal.id}` });
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setLabel("View appeal").setStyle(ButtonStyle.Link).setURL(getAppealStatusUrl(guild.id, appeal.id)),
  );
  if (extraButton) row.addComponents(new ButtonBuilder().setLabel(extraButton.label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(extraButton.url));
  return Boolean(await user.send(containerReply(container, false, [row])).catch(() => null));
}

function threadNote(title: string, emoji: string, color: number, text: string, client: Client): ResultContainer {
  return setEmbedAuthor(baseEmbed(), title, client, { emoji }).setColor(color).setDescription(text.slice(0, 2000));
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export type ActionResult = { ok: true; appeal: AppealRecord; notes: string[] } | { ok: false; error: string };

export type SubmitResult =
  | { ok: true; appeal: AppealRecord; posted: boolean }
  | { ok: false; error: string; errors?: Record<string, string> };

/**
 * A user's appeal from the website. Eligibility and every answer are checked again here (the page
 * checks too, but this is what counts), then it's saved, posted for review and logged.
 */
export async function submitAppeal(
  guild: Guild,
  guildConfig: GuildConfig,
  config: AppealsConfig,
  userId: string,
  target: { caseId: number } | { manual: true },
  raw: Record<string, RawAnswer>,
): Promise<SubmitResult> {
  if (!config.accepting) return { ok: false, error: "This server isn't taking appeals right now." };
  const situation = await viewerSituation(guild, config, userId);
  if (situation.options.block) return { ok: false, error: "You can't send an appeal right now." };

  let caseId: number | null = null;
  let infractionType: string | null = null;
  let snapshot = null;
  let formId: string;
  if ("caseId" in target) {
    const option = situation.options.cases.find((item) => item.case.id === target.caseId);
    if (!option) return { ok: false, error: "That infraction can't be appealed." };
    if (option.state !== "appealable") return { ok: false, error: "That infraction can't be appealed right now." };
    caseId = option.case.id;
    infractionType = option.case.type;
    snapshot = {
      type: option.case.type,
      reason: option.case.reason,
      modId: option.case.modId,
      active: option.case.active,
      createdAt: option.case.createdAt.toISOString(),
      expiresAt: option.case.expiresAt?.toISOString() ?? null,
    };
    formId = option.formId;
  } else {
    if (situation.options.manual.state !== "appealable") return { ok: false, error: "Manual appeals aren't available to you." };
    infractionType = situation.isBanned ? "ban" : null;
    formId = situation.options.manual.formId;
  }

  const form = formById(config, formId);
  if (!form) return { ok: false, error: "This server hasn't set up an appeal form yet." };
  const validation = validateAppealAnswers(form, raw);
  if (!validation.ok) return { ok: false, error: "Some answers need another look.", errors: validation.errors };

  const appeal = createAppeal({
    guildId: guild.id,
    userId,
    caseId,
    infractionType,
    caseSnapshot: snapshot,
    formId: form.id,
    formName: form.name,
    answers: validation.answers,
  });
  const user = await guild.client.users.fetch(userId).catch(() => null);
  const posted = await postAppealForReview(guild, config, appeal, user);
  await logAppeal(guild.client, guildConfig, appeal, "appeal_submitted", "Appeal Submitted");
  return { ok: true, appeal: getAppeal(guild.id, appeal.id) ?? appeal, posted };
}

/**
 * Approves or denies an open appeal: records it, lifts the punishment when `reverse` is on, DMs
 * the user, updates the review message and logs it. Shared by the review buttons and the
 * dashboard. `notes` lists anything that didn't fully go through (e.g. DMs closed).
 */
/**
 * Lifting a punishment through an appeal needs the same power as lifting it directly: Appeals'
 * own review permission only lets someone decide, never unban or untimeout on their own say-so.
 * Returns why not, or null when the reviewer may lift it.
 */
async function liftBlockedReason(
  guild: Guild,
  guildConfig: GuildConfig,
  reviewerId: string,
  appeal: AppealRecord,
): Promise<string | null> {
  if (isDashboardSuperuser(reviewerId) || guild.ownerId === reviewerId) return null;
  const member = await guild.members.fetch(reviewerId).catch(() => null);
  if (!member) return "You need to be in the server to lift a punishment.";
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return null;
  }
  const type = appeal.infractionType ?? "ban";
  const [discordFlag, dreamlinerFlag, what] =
    type === "ban" || type === "tempban" || appeal.kind === "manual"
      ? ([PermissionFlagsBits.BanMembers, "can_unban", "unban people"] as const)
      : type === "mute" || type === "tempmute"
        ? ([PermissionFlagsBits.ModerateMembers, "can_mute", "remove timeouts"] as const)
        : ([PermissionFlagsBits.ModerateMembers, "can_warn", "revoke cases"] as const);
  if (member.permissions.has(discordFlag)) return null;
  if (await hasPermission(guild.id, "infractions", dreamlinerFlag, member, guildConfig)) return null;
  return `You don't have permission to ${what}, so you can't lift this one. Untick "Lift the punishment" to approve it without changing anything, or ask someone who can.`;
}

const SELF_REVIEW = "You can't review your own appeal. Ask another staff member.";

export async function decideAppeal(
  guild: Guild,
  guildConfig: GuildConfig,
  config: AppealsConfig,
  appealId: number,
  decision: "approved" | "denied",
  reviewerId: string,
  reason: string | null,
  reverse: boolean,
): Promise<ActionResult> {
  const trimmed = reason?.trim().slice(0, 1000) || null;
  if (decision === "denied" && config.review.require_deny_reason && !trimmed) {
    return { ok: false, error: "Give a reason for denying it (it's sent to the user)." };
  }
  const current = getAppeal(guild.id, appealId);
  if (!current) return { ok: false, error: "That appeal doesn't exist." };
  if (current.userId === reviewerId) return { ok: false, error: SELF_REVIEW };
  if (decision === "approved" && reverse) {
    const blocked = await liftBlockedReason(guild, guildConfig, reviewerId, current);
    if (blocked) return { ok: false, error: blocked };
  }
  let appeal = transitionAppeal(guild.id, appealId, OPEN_STATUSES, decision, {
    reviewerId,
    decisionReason: trimmed,
    decidedAt: new Date(),
  });
  if (!appeal) return { ok: false, error: "That appeal was already decided, or doesn't exist." };
  addEvent(appeal.id, decision, reviewerId, trimmed);

  const notes: string[] = [];
  let invite: string | null = null;
  if (decision === "approved" && reverse) {
    const result = await reversePunishment(guild.client, guild, guildConfig, appeal, reviewerId);
    appeal = setReversal(appeal.id, result.ok, result.note) ?? appeal;
    addEvent(appeal.id, "reversed", reviewerId, result.note);
    if (!result.ok) {
      notes.push(result.note);
      await logAppeal(guild.client, guildConfig, appeal, "appeal_reversal_failed", "Appeal Couldn't Lift Punishment", {
        actorId: reviewerId,
        note: result.note,
      });
    } else if (result.unbanned && config.decisions.invite_on_unban) {
      invite = await createRejoinInvite(guild, config, appeal.id);
      if (!invite) notes.push("Couldn't make an invite back (I need Create Invite in a text channel).");
    }
  }

  if (config.decisions.dm_user) {
    const user = await guild.client.users.fetch(appeal.userId).catch(() => null);
    const template = decision === "approved" ? config.decisions.approve_message : config.decisions.deny_message;
    const lifted = decision === "approved" && appeal.reversed ? `${appeal.reversalNote ?? "The punishment was lifted"}.` : "";
    const text = user
      ? dmText(template, guild, user, appeal, decision === "approved" ? { reason: trimmed, lifted, reasonLabel: "Note" } : { reason: trimmed, reasonLabel: "Reason" })
      : "";
    const sent = await dmAppellant(
      guild,
      appeal,
      decision === "approved" ? "Appeal approved" : "Appeal denied",
      decision === "approved" ? APPEAL_EMOJIS.approved : APPEAL_EMOJIS.denied,
      text,
      invite ? { label: `Rejoin ${guild.name}`, url: invite } : undefined,
    );
    if (!sent) notes.push("The user has DMs closed (or isn't reachable), so they weren't notified. They can still see it on their appeal page.");
  }

  await refreshAppealReview(
    guild,
    config,
    appeal,
    threadNote(
      decision === "approved" ? "Appeal approved" : "Appeal denied",
      decision === "approved" ? APPEAL_EMOJIS.approved : APPEAL_EMOJIS.denied,
      STATUS_COLORS[decision],
      [`By <@${reviewerId}>`, trimmed ? `**${decision === "approved" ? "Note" : "Reason"}:** ${trimmed}` : "", appeal.reversalNote ?? ""]
        .filter(Boolean)
        .join("\n"),
      guild.client,
    ),
  );
  await logAppeal(guild.client, guildConfig, appeal, decision === "approved" ? "appeal_approved" : "appeal_denied", decision === "approved" ? "Appeal Approved" : "Appeal Denied", {
    actorId: reviewerId,
    reason: trimmed,
    note: appeal.reversalNote,
  });
  return { ok: true, appeal, notes };
}

/** Staff ask the user a question: the appeal waits for their reply on the appeal page. */
export async function requestAppealInfo(
  guild: Guild,
  guildConfig: GuildConfig,
  config: AppealsConfig,
  appealId: number,
  reviewerId: string,
  question: string,
): Promise<ActionResult> {
  const text = question.trim();
  if (!text) return { ok: false, error: "Write the question for the user." };
  if (getAppeal(guild.id, appealId)?.userId === reviewerId) return { ok: false, error: SELF_REVIEW };
  const appeal = transitionAppeal(guild.id, appealId, ["pending"], "needs_info");
  if (!appeal) return { ok: false, error: "Only appeals waiting for review can be sent back with a question." };
  addEvent(appeal.id, "info_requested", reviewerId, text.slice(0, 1000));

  const notes: string[] = [];
  const user = await guild.client.users.fetch(appeal.userId).catch(() => null);
  const sent = user
    ? await dmAppellant(
        guild,
        appeal,
        "Question about your appeal",
        APPEAL_EMOJIS.needsInfo,
        dmText(config.decisions.needs_info_message, guild, user, appeal, { reason: text, reasonLabel: "Question" }),
      )
    : false;
  if (!sent) notes.push("The user has DMs closed, so they weren't told. The question is waiting on their appeal page.");

  await refreshAppealReview(
    guild,
    config,
    appeal,
    threadNote("Asked for more info", APPEAL_EMOJIS.needsInfo, STATUS_COLORS.needs_info, `<@${reviewerId}>: ${text}`, guild.client),
  );
  await logAppeal(guild.client, guildConfig, appeal, "appeal_info", "Appeal Needs Info", { actorId: reviewerId, reason: text });
  return { ok: true, appeal, notes };
}

/** The user answers staff's question: the appeal goes back to waiting for review. */
export async function replyToAppealInfo(
  guild: Guild,
  guildConfig: GuildConfig,
  config: AppealsConfig,
  appealId: number,
  userId: string,
  reply: string,
): Promise<ActionResult> {
  const text = reply.trim();
  if (text.length < 2) return { ok: false, error: "Write a reply first." };
  if (text.length > 2000) return { ok: false, error: "Please keep your reply under 2000 characters." };
  const current = getAppeal(guild.id, appealId);
  if (!current || current.userId !== userId) return { ok: false, error: "Appeal not found." };
  const appeal = transitionAppeal(guild.id, appealId, ["needs_info"], "pending");
  if (!appeal) return { ok: false, error: "This appeal isn't waiting for a reply." };
  addEvent(appeal.id, "info_replied", userId, text);

  await refreshAppealReview(
    guild,
    config,
    appeal,
    threadNote("The user replied", APPEAL_EMOJIS.submitted, STATUS_COLORS.pending, text, guild.client),
  );
  await logAppeal(guild.client, guildConfig, appeal, "appeal_info", "Appeal Reply", { reason: text.slice(0, 300) });
  return { ok: true, appeal, notes: [] };
}

/** The user takes their appeal back. It doesn't count towards the server's appeal limit. */
export async function withdrawAppeal(guild: Guild, config: AppealsConfig, appealId: number, userId: string): Promise<ActionResult> {
  const current = getAppeal(guild.id, appealId);
  if (!current || current.userId !== userId) return { ok: false, error: "Appeal not found." };
  const appeal = transitionAppeal(guild.id, appealId, OPEN_STATUSES, "withdrawn");
  if (!appeal) return { ok: false, error: "This appeal can't be withdrawn any more." };
  addEvent(appeal.id, "withdrawn", userId, null);
  await refreshAppealReview(guild, config, appeal, threadNote("Withdrawn by the user", APPEAL_EMOJIS.denied, STATUS_COLORS.withdrawn, "No decision needed.", guild.client));
  return { ok: true, appeal, notes: [] };
}

/** A staff-only note on an appeal (never shown to the user). */
export async function addAppealNote(
  guild: Guild,
  config: AppealsConfig,
  appealId: number,
  actorId: string,
  body: string,
): Promise<ActionResult> {
  const text = body.trim();
  if (!text) return { ok: false, error: "Write the note first." };
  const appeal = getAppeal(guild.id, appealId);
  if (!appeal) return { ok: false, error: "Appeal not found." };
  if (appeal.userId === actorId) {
    return { ok: false, error: "You can't add notes to your own appeal. Ask another staff member to review it." };
  }
  addEvent(appeal.id, "note", actorId, text.slice(0, 2000));
  // The discussion thread is staff-only, so the note goes there too for anyone reviewing in Discord.
  if (appeal.threadId) {
    await refreshAppealReview(
      guild,
      config,
      appeal,
      threadNote("Staff note", APPEAL_EMOJIS.note, STATUS_COLORS.pending, `By <@${actorId}>\n${text.slice(0, 1800)}`, guild.client),
    );
  }
  return { ok: true, appeal, notes: [] };
}
