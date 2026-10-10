import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import type { AppealStatus, AppealsConfig } from "../config/schemas/appeals.js";
import { APPEAL_STATUSES } from "../config/schemas/appeals.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import type { TicketFormQuestion } from "../config/schemas/tickets.js";
import { renderTemplate } from "../core/templates.js";
import { colorIntToHex } from "../plugins/passport/functions/messageBuilder.js";
import { activeAppealsConfig, formById, loadAppealsConfig, PLUGIN, typeLabel } from "../plugins/appeals/functions/config.js";
import type { BlockReason, CaseState, ManualState } from "../plugins/appeals/functions/eligibility.js";
import { appealSubject } from "../plugins/appeals/functions/review.js";
import {
  addAppealNote,
  decideAppeal,
  replyToAppealInfo,
  requestAppealInfo,
  submitAppeal,
  viewerSituation,
  withdrawAppeal,
  type ActionResult,
} from "../plugins/appeals/functions/service.js";
import {
  appealStats,
  getAppeal,
  latestQuestion,
  listAppeals,
  listEvents,
  listUserAppeals,
  type AppealEvent,
  type AppealRecord,
  type AppealsQuery,
} from "../plugins/appeals/functions/store.js";
import type { RawAnswer } from "../plugins/appeals/functions/validate.js";
import { getInfraction } from "../plugins/infraction/functions/infractions.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { hasPermission } from "../core/permissionRoles.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import { resolvePerson, type WebPerson } from "./webReviews.js";

/**
 * The website side of Appeals: the public appeal page (/server/<id>/appeals, for anyone signed in,
 * members or not: banned users can't be members) and the dashboard's View Appeals page.
 */

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

// ---------------------------------------------------------------------------------------------
// Public page
// ---------------------------------------------------------------------------------------------

/** Only what the website needs to render a form (no dashboard-only fields). */
export type PublicAppealForm = {
  id: string;
  name: string;
  intro: string;
  questions: TicketFormQuestion[];
};

export type PublicAppealCase = {
  id: number;
  type: string;
  typeLabel: string;
  reason: string | null;
  moderator: WebPerson | null;
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
  state: CaseState;
  until: string | null;
  appealId: number | null;
  formId: string;
};

export type PublicAppealSummary = {
  id: number;
  status: AppealStatus;
  subject: string;
  createdAt: string;
  decidedAt: string | null;
};

export type AppealsPagePayload = {
  ok: true;
  enabled: boolean;
  accepting: boolean;
  guild: { id: string; name: string; icon: string | null; banner: string | null };
  theme: { accentColor: string };
  background: { type: string; color: string; url: string };
  page: {
    headline: string;
    body: string;
    guidelines: string;
    loginButtonLabel: string;
    showServerIcon: boolean;
    submittedTitle: string;
    submittedBody: string;
    closedTitle: string;
    closedBody: string;
  };
  manual: { label: string; description: string };
  forms: Record<string, PublicAppealForm>;
  viewer: null | {
    userId: string;
    isBanned: boolean;
    isMember: boolean;
    block: (Omit<BlockReason, "until"> & { until?: string }) | null;
    cases: PublicAppealCase[];
    manual: { state: ManualState; until: string | null; appealId: number | null; formId: string };
    appeals: PublicAppealSummary[];
  };
};

function pageAccent(guildConfig: GuildConfig, config: AppealsConfig): string {
  return colorIntToHex(config.page.inherit_accent ? guildConfig.server_accent_color : config.page.accent_color);
}

function render(text: string, guild: Guild): string {
  return renderTemplate(text, { guild }).trim();
}

function publicForm(config: AppealsConfig, formId: string): PublicAppealForm | null {
  const form = formById(config, formId);
  return form ? { id: form.id, name: form.name, intro: form.intro, questions: form.questions } : null;
}

function summary(appeal: AppealRecord): PublicAppealSummary {
  return {
    id: appeal.id,
    status: appeal.status,
    subject: appealSubject(appeal),
    createdAt: appeal.createdAt.toISOString(),
    decidedAt: iso(appeal.decidedAt),
  };
}

export async function buildAppealsPagePayload(guild: Guild, viewerUserId?: string | null): Promise<AppealsPagePayload> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = loadAppealsConfig(guildConfig);
  const enabled = pluginEnabled(guildConfig, PLUGIN);
  const page = config.page;

  const forms: Record<string, PublicAppealForm> = {};
  const addForm = (formId: string) => {
    const form = publicForm(config, formId);
    if (form) forms[formId] = form;
  };

  let viewer: AppealsPagePayload["viewer"] = null;
  const userId = viewerUserId?.trim();
  if (enabled && userId && /^\d{17,20}$/.test(userId)) {
    const situation = await viewerSituation(guild, config, userId);
    const moderators = new Map<string, WebPerson>();
    const cases: PublicAppealCase[] = [];
    for (const option of situation.options.cases) {
      let moderator: WebPerson | null = null;
      if (page.show_moderator) {
        moderator = moderators.get(option.case.modId) ?? (await resolvePerson(guild, option.case.modId));
        moderators.set(option.case.modId, moderator);
      }
      if (option.state === "appealable") addForm(option.formId);
      cases.push({
        id: option.case.id,
        type: option.case.type,
        typeLabel: typeLabel(option.case.type),
        reason: page.show_case_reason ? option.case.reason : null,
        moderator,
        active: option.case.active,
        createdAt: option.case.createdAt.toISOString(),
        expiresAt: iso(option.case.expiresAt),
        state: option.state,
        until: iso(option.until),
        appealId: option.appealId,
        formId: option.formId,
      });
    }
    const manual = situation.options.manual;
    if (manual.state === "appealable") addForm(manual.formId);
    const block = situation.options.block;
    viewer = {
      userId,
      isBanned: situation.isBanned,
      isMember: situation.isMember,
      block: block ? (block.kind === "account_too_new" ? { kind: block.kind, until: block.until.toISOString() } : block) : null,
      cases,
      manual: { state: manual.state, until: iso(manual.until), appealId: manual.appealId, formId: manual.formId },
      appeals: situation.appeals.map(summary),
    };
  }

  return {
    ok: true,
    enabled,
    accepting: config.accepting,
    guild: { id: guild.id, name: guild.name, icon: guild.icon, banner: guild.banner },
    theme: { accentColor: pageAccent(guildConfig, config) },
    background: {
      type: page.background,
      color: colorIntToHex(page.background_color),
      // Uploaded images are served by the website from a cacheable, id-addressed URL.
      url:
        page.background === "asset"
          ? page.background_asset_id
            ? `/api/appeals/${guild.id}/background/${page.background_asset_id}`
            : ""
          : page.background_url,
    },
    page: {
      headline: render(page.headline, guild),
      body: render(page.body, guild),
      guidelines: page.guidelines,
      loginButtonLabel: page.login_button_label,
      showServerIcon: page.show_server_icon,
      submittedTitle: render(page.submitted_title, guild),
      submittedBody: render(page.submitted_body, guild),
      closedTitle: render(page.closed_title, guild),
      closedBody: render(page.closed_body, guild),
    },
    manual: { label: config.manual.label, description: config.manual.description },
    forms,
    viewer,
  };
}

/** Per-user throttle on public writes (submit, reply, withdraw): a few a minute is plenty. */
const publicWrites = new SlidingWindowLimiter(5, 60_000);
export function publicWriteAllowed(userId: string): boolean {
  return publicWrites.take(userId).ok;
}

export async function submitWebAppeal(
  guild: Guild,
  userId: string,
  body: { caseId?: unknown; manual?: unknown; answers?: unknown },
): Promise<{ ok: true; appealId: number; posted: boolean } | { ok: false; error: string; errors?: Record<string, string> }> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = activeAppealsConfig(guildConfig);
  if (!config) return { ok: false, error: "This server isn't taking appeals." };
  const target =
    body.manual === true
      ? ({ manual: true } as const)
      : Number.isInteger(Number(body.caseId)) && Number(body.caseId) > 0
        ? { caseId: Number(body.caseId) }
        : null;
  if (!target) return { ok: false, error: "Pick what you're appealing." };
  const answers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? (body.answers as Record<string, RawAnswer>) : {};
  const result = await submitAppeal(guild, guildConfig, config, userId, target, answers);
  return result.ok ? { ok: true, appealId: result.appeal.id, posted: result.posted } : result;
}

export type PublicAppealEvent = {
  id: number;
  kind: AppealEvent["kind"];
  /** "you" for the appellant's own events, otherwise "staff" (or a name, if the server shows moderators). */
  actor: string;
  body: string | null;
  createdAt: string;
};

export type MyAppealPayload = {
  appeal: {
    id: number;
    status: AppealStatus;
    subject: string;
    caseType: string | null;
    caseReason: string | null;
    caseCreatedAt: string | null;
    formName: string;
    answers: { label: string; answer: string }[];
    decisionReason: string | null;
    reversalNote: string | null;
    question: string | null;
    createdAt: string;
    decidedAt: string | null;
  };
  events: PublicAppealEvent[];
};

/** One appeal for its owner (the status page). Staff notes never leave the bot. */
export async function getMyAppeal(guild: Guild, appealId: number, userId: string): Promise<MyAppealPayload | null> {
  const appeal = getAppeal(guild.id, appealId);
  if (!appeal || appeal.userId !== userId) return null;
  const config = loadAppealsConfig(await configManager.getEffectiveConfig(guild.id));
  const names = new Map<string, string>();
  const actorName = async (actorId: string | null): Promise<string> => {
    if (!actorId) return "staff";
    if (actorId === userId) return "you";
    if (!config.page.show_moderator) return "staff";
    if (!names.has(actorId)) names.set(actorId, (await resolvePerson(guild, actorId)).name);
    return names.get(actorId)!;
  };
  const events: PublicAppealEvent[] = [];
  for (const event of listEvents(appeal.id, false)) {
    events.push({ id: event.id, kind: event.kind, actor: await actorName(event.actorId), body: event.body, createdAt: event.createdAt.toISOString() });
  }
  return {
    appeal: {
      id: appeal.id,
      status: appeal.status,
      subject: appealSubject(appeal),
      caseType: appeal.caseSnapshot?.type ?? appeal.infractionType,
      caseReason: config.page.show_case_reason ? (appeal.caseSnapshot?.reason ?? null) : null,
      caseCreatedAt: appeal.caseSnapshot?.createdAt ?? null,
      formName: appeal.formName,
      answers: appeal.answers.map((answer) => ({ label: answer.label, answer: answer.answer })),
      decisionReason: appeal.status === "approved" || appeal.status === "denied" ? appeal.decisionReason : null,
      reversalNote: appeal.status === "approved" ? appeal.reversalNote : null,
      question: appeal.status === "needs_info" ? (latestQuestion(appeal.id)?.body ?? null) : null,
      createdAt: appeal.createdAt.toISOString(),
      decidedAt: iso(appeal.decidedAt),
    },
    events,
  };
}

export async function replyToWebAppeal(guild: Guild, appealId: number, userId: string, reply: string): Promise<ActionResult> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = activeAppealsConfig(guildConfig);
  if (!config) return { ok: false, error: "This server isn't taking appeals." };
  return replyToAppealInfo(guild, guildConfig, config, appealId, userId, reply);
}

export async function withdrawWebAppeal(guild: Guild, appealId: number, userId: string): Promise<ActionResult> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  return withdrawAppeal(guild, loadAppealsConfig(guildConfig), appealId, userId);
}

// ---------------------------------------------------------------------------------------------
// Staff (View Appeals)
// ---------------------------------------------------------------------------------------------

/** Server managers, or anyone granted the Appeals permission for this (Dreamliner roles). */
export async function staffCan(guild: Guild, userId: string, flag: "can_view" | "can_review", canManage: boolean): Promise<boolean> {
  if (canManage) return true;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  return (
    (await hasPermission(guild.id, PLUGIN, flag, member, guildConfig)) ||
    (flag === "can_view" && (await hasPermission(guild.id, PLUGIN, "can_review", member, guildConfig)))
  );
}

export type WebAppealRow = {
  id: number;
  status: AppealStatus;
  kind: "case" | "manual";
  subject: string;
  caseId: number | null;
  infractionType: string | null;
  user: WebPerson;
  reviewer: WebPerson | null;
  createdAt: string;
  decidedAt: string | null;
};

export function parseAppealsQuery(url: URL): AppealsQuery {
  const status = url.searchParams.get("status");
  return {
    status: (APPEAL_STATUSES as readonly string[]).includes(status ?? "") ? (status as AppealStatus) : null,
    type: url.searchParams.get("type")?.trim() || null,
    userId: url.searchParams.get("user")?.trim() || null,
    q: url.searchParams.get("q")?.trim().slice(0, 100) ?? "",
    limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40)),
    offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
  };
}

async function toRow(guild: Guild, appeal: AppealRecord, people: Map<string, WebPerson>): Promise<WebAppealRow> {
  const person = async (id: string) => {
    if (!people.has(id)) people.set(id, await resolvePerson(guild, id));
    return people.get(id)!;
  };
  return {
    id: appeal.id,
    status: appeal.status,
    kind: appeal.kind,
    subject: appealSubject(appeal),
    caseId: appeal.caseId,
    infractionType: appeal.infractionType,
    user: await person(appeal.userId),
    reviewer: appeal.reviewerId ? await person(appeal.reviewerId) : null,
    createdAt: appeal.createdAt.toISOString(),
    decidedAt: iso(appeal.decidedAt),
  };
}

export async function listWebAppeals(guild: Guild, query: AppealsQuery) {
  const { rows, total, counts } = listAppeals(guild.id, query);
  const people = new Map<string, WebPerson>();
  const appeals: WebAppealRow[] = [];
  for (const row of rows) appeals.push(await toRow(guild, row, people));
  return { appeals, total, counts, offset: query.offset };
}

export function webAppealStats(guild: Guild, days: number) {
  const stats = appealStats(guild.id, Math.min(365, Math.max(1, days)));
  return { ...stats, approvalRate: stats.decided > 0 ? stats.approved / stats.decided : null };
}

export type WebAppealDetail = WebAppealRow & {
  formName: string;
  answers: { label: string; answer: string }[];
  caseSnapshot: AppealRecord["caseSnapshot"];
  /** The infraction as it is now (it may have been edited or lifted since). */
  liveCase: { id: number; type: string; reason: string | null; active: boolean; createdAt: string; expiresAt: string | null } | null;
  moderator: WebPerson | null;
  decisionReason: string | null;
  reversed: boolean;
  reversalNote: string | null;
  liftByDefault: boolean;
  /** The staff member looking at it is the appellant: they can read it but not decide or add notes. */
  ownAppeal: boolean;
  events: { id: number; kind: AppealEvent["kind"]; actor: WebPerson | null; body: string | null; createdAt: string }[];
  history: WebAppealRow[];
  messageUrl: string | null;
  threadUrl: string | null;
};

/** `viewerId`: staff looking at their own appeal never see the staff notes about it. */
export async function getWebAppeal(guild: Guild, appealId: number, viewerId?: string): Promise<WebAppealDetail | null> {
  const appeal = getAppeal(guild.id, appealId);
  if (!appeal) return null;
  const ownAppeal = Boolean(viewerId && viewerId === appeal.userId);
  const config = loadAppealsConfig(await configManager.getEffectiveConfig(guild.id));
  const people = new Map<string, WebPerson>();
  const row = await toRow(guild, appeal, people);
  const person = async (id: string | null) => {
    if (!id) return null;
    if (!people.has(id)) people.set(id, await resolvePerson(guild, id));
    return people.get(id)!;
  };
  const live = appeal.caseId ? await getInfraction(guild.id, appeal.caseId) : null;
  const events: WebAppealDetail["events"] = [];
  for (const event of listEvents(appeal.id, !ownAppeal)) {
    events.push({ id: event.id, kind: event.kind, actor: await person(event.actorId), body: event.body, createdAt: event.createdAt.toISOString() });
  }
  const history: WebAppealRow[] = [];
  for (const other of listUserAppeals(guild.id, appeal.userId).filter((item) => item.id !== appeal.id).slice(0, 10)) {
    history.push(await toRow(guild, other, people));
  }
  const rule = appeal.infractionType ? config.types[appeal.infractionType as keyof AppealsConfig["types"]] : undefined;
  return {
    ...row,
    formName: appeal.formName,
    answers: appeal.answers.map((answer) => ({ label: answer.label, answer: answer.answer })),
    caseSnapshot: appeal.caseSnapshot,
    liveCase: live
      ? { id: live.id, type: live.type, reason: live.reason, active: live.active, createdAt: live.createdAt.toISOString(), expiresAt: iso(live.expiresAt) }
      : null,
    moderator: await person(appeal.caseSnapshot?.modId ?? null),
    decisionReason: appeal.decisionReason,
    reversed: appeal.reversed,
    reversalNote: appeal.reversalNote,
    liftByDefault: appeal.kind === "manual" ? true : (rule?.auto_reverse ?? true),
    ownAppeal,
    events,
    history,
    messageUrl:
      appeal.reviewChannelId && appeal.reviewMessageId
        ? `https://discord.com/channels/${guild.id}/${appeal.reviewChannelId}/${appeal.reviewMessageId}`
        : null,
    threadUrl: appeal.threadId ? `https://discord.com/channels/${guild.id}/${appeal.threadId}` : null,
  };
}

export async function staffAppealAction(
  guild: Guild,
  appealId: number,
  actorId: string,
  action: "decision" | "info" | "note",
  body: { decision?: unknown; reason?: unknown; reverse?: unknown; question?: unknown; note?: unknown },
): Promise<ActionResult> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = loadAppealsConfig(guildConfig);
  const text = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 1000) : "");
  if (action === "note") return addAppealNote(guild, config, appealId, actorId, text(body.note));
  if (action === "info") return requestAppealInfo(guild, guildConfig, config, appealId, actorId, text(body.question));
  if (body.decision !== "approved" && body.decision !== "denied") return { ok: false, error: "decision must be approved or denied" };
  return decideAppeal(guild, guildConfig, config, appealId, body.decision, actorId, text(body.reason) || null, body.reverse !== false);
}

/** What could stop appeals working: where they're posted, and what lifting a punishment needs. */
export async function appealDiagnostics(guild: Guild) {
  const config = loadAppealsConfig(await configManager.getEffectiveConfig(guild.id));
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const channelId = config.review.channel_id?.trim();
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  const perms = channel && me ? channel.permissionsFor(me) : null;
  const canPost = Boolean(
    perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]),
  );
  const canThread = !config.review.thread || Boolean(perms?.has(PermissionFlagsBits.CreatePublicThreads));
  const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
  const canInvite = me ? textChannels.some((c) => Boolean(c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite))) : false;
  const checks = [
    {
      id: "review_channel",
      ok: Boolean(channel) && canPost,
      label: "Review channel",
      detail: !channelId
        ? "Pick a review channel so staff see new appeals in Discord."
        : !channel
          ? "I can't find that channel any more."
          : canPost
            ? `New appeals post in #${"name" in channel ? channel.name : "channel"}.`
            : "I can't post there: give me View Channel, Send Messages and Embed Links.",
    },
    {
      id: "threads",
      ok: canThread,
      label: "Discussion threads",
      detail: !config.review.thread ? "Off." : canThread ? "I can start a thread on each appeal." : "I need Create Public Threads in the review channel.",
    },
    {
      id: "unban",
      ok: Boolean(me?.permissions.has(PermissionFlagsBits.BanMembers)),
      label: "Lift bans",
      detail: me?.permissions.has(PermissionFlagsBits.BanMembers) ? "I can unban approved appeals." : "I need Ban Members to unban approved appeals.",
    },
    {
      id: "unmute",
      ok: Boolean(me?.permissions.has(PermissionFlagsBits.ModerateMembers)),
      label: "Lift timeouts",
      detail: me?.permissions.has(PermissionFlagsBits.ModerateMembers)
        ? "I can remove timeouts for approved appeals."
        : "I need Moderate Members to remove timeouts.",
    },
    {
      id: "invite",
      ok: !config.decisions.invite_on_unban || canInvite,
      label: "Invite back",
      detail: !config.decisions.invite_on_unban
        ? "Off."
        : canInvite
          ? "I can send unbanned users a single-use invite."
          : "I need Create Invite in a text channel.",
    },
  ];
  return { checks };
}

/** Appeals against given infractions, for the Cases page. */
export async function appealsForCases(guild: Guild, caseIds: number[]) {
  const { listCaseAppeals } = await import("../plugins/appeals/functions/store.js");
  return listCaseAppeals(guild.id, caseIds).map((appeal) => ({
    id: appeal.id,
    caseId: appeal.caseId,
    status: appeal.status,
    createdAt: appeal.createdAt.toISOString(),
  }));
}
