import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { configManager } from "../../../config/manager.js";
import { guildResultOptions } from "../../../core/embeds.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { containerEdit, resultEdit, resultReply } from "../../../core/responses.js";
import { translatorFor } from "../../../i18n/index.js";
import { describeAction, performTeamAction, type ActionResult } from "./actions.js";
import { CONFIRM_TTL_MS, MAX_COMMENT, MAX_REASON, PLUGIN, TEAM_PREFIX, type LeaveKind, type TeamActionType } from "./config.js";
import { cleanComment, RATE_BUTTON, RATE_COMMENT_BUTTON, RATE_COMMENT_MODAL, recordTicketRating, STARS } from "./feedback.js";
import { decideLeave, LEAVE_BUTTON, LEAVE_DENY_MODAL, LEAVE_REQUEST_MODAL, requestLeave } from "./leave.js";
import { loadTeamRuntime } from "./members.js";
import { teamCard } from "./messages.js";
import { TRIAL_BUTTON, TRIAL_EXTEND_DAYS, TRIAL_FAIL_MODAL, trialReviewRow } from "./onboarding.js";
import { isOnTeam, resolveActor, type TeamActor } from "./ranks.js";
import { ROSTER_BUTTON } from "./roster.js";
import { endOwnShift, startShift, toggleBreak } from "./shifts.js";
import { getFeedback, getLeave, getTeamMember, setFeedbackComment, upsertTeamMember } from "./store.js";

type Runtime = NonNullable<Awaited<ReturnType<typeof loadTeamRuntime>>>;

export type ActionRequestInput = { targetId: string; type: TeamActionType; rankId?: string | null; reason: string; days?: number | null };

/** Runs a staff action for a member or the dashboard with the guild's runtime config. */
export function runTeamAction(guild: Guild, runtime: Runtime, actor: TeamActor, input: ActionRequestInput): Promise<ActionResult> {
  return performTeamAction({ guild, guildConfig: runtime.guildConfig, config: runtime.config, actor, ...input });
}

// ── Confirmations ("Yes, remove them") ───────────────────────────────────────
// Kept in memory for five minutes, at most 200 at once (oldest dropped first).

const CONFIRM_MAX = 200;
const confirmations = new Map<string, ActionRequestInput & { guildId: string; actorId: string; at: number }>();

export function createConfirmation(input: ActionRequestInput & { guildId: string; actorId: string }): string {
  const token = randomBytes(6).toString("hex");
  const now = Date.now();
  for (const [key, value] of confirmations) if (now - value.at > CONFIRM_TTL_MS) confirmations.delete(key);
  confirmations.set(token, { ...input, at: now });
  while (confirmations.size > CONFIRM_MAX) confirmations.delete(confirmations.keys().next().value!);
  return token;
}

export function forgetGuildConfirmations(guildId: string): void {
  for (const [key, value] of confirmations) if (value.guildId === guildId) confirmations.delete(key);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Ctx = { guild: Guild; member: GuildMember; runtime: Runtime; t: Awaited<ReturnType<typeof translatorFor>>["t"]; options: ReturnType<typeof guildResultOptions> };

async function resolveCtx(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<Ctx | null> {
  const { t } = await translatorFor(interaction.user.id);
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;
  const runtime = guild ? await loadTeamRuntime(guild.id) : null;
  if (!guild || !member || !runtime) {
    await interaction.reply(resultReply("Team", t("team_control.unavailable", "Team Control isn't available here anymore."), true, { tone: "error" }));
    return null;
  }
  return { guild, member, runtime, t, options: guildResultOptions(interaction.client, runtime.guildConfig) };
}

async function ephemeral(interaction: ButtonInteraction | ModalSubmitInteraction, ctx: Ctx, body: string, tone: "success" | "warning" | "error" | "neutral" = "neutral") {
  const payload = resultReply("Team", body, true, { ...ctx.options, tone });
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

async function denied(interaction: ButtonInteraction | ModalSubmitInteraction, ctx: Ctx) {
  await ephemeral(interaction, ctx, ctx.t("common.noPermission", "You do not have permission to use this command."), "error");
}

function reasonModal(customId: string, title: string, label: string, required: boolean) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(label)
        .setTextInputComponent(new TextInputBuilder().setCustomId("reason").setStyle(TextInputStyle.Paragraph).setRequired(required).setMaxLength(MAX_REASON)),
    );
}

// ── Buttons ──────────────────────────────────────────────────────────────────

export async function handleTeamButton(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith(TEAM_PREFIX)) return false;

  // Ticket rating DMs have no guild.
  if (id.startsWith(RATE_BUTTON)) {
    const [guildId, ticketId, score] = id.slice(RATE_BUTTON.length).split(":");
    const result = await recordTicketRating(interaction.client, guildId ?? "", Number(ticketId), interaction.user.id, Number(score));
    const guildConfig = await configManager.getEffectiveConfig(guildId ?? "").catch(() => null);
    const options = guildConfig ? guildResultOptions(interaction.client, guildConfig) : { client: interaction.client };
    if (!result.ok) {
      await interaction.reply(resultReply("Feedback", result.error, true, { ...options, tone: "warning" }));
      return true;
    }
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
    await interaction.update(
      resultEdit("Feedback", `Thanks for rating **${STARS(result.feedback.rating)}**! Want to add a comment?`, { ...options, tone: "success" }, [
        new ActionRowBuilder<InstanceType<typeof ButtonBuilder>>().addComponents(
          new ButtonBuilder().setCustomId(`${RATE_COMMENT_BUTTON}${result.feedback.id}`).setLabel("Add a comment").setStyle(ButtonStyle.Secondary),
        ),
      ]),
    );
    return true;
  }
  if (id.startsWith(RATE_COMMENT_BUTTON)) {
    const feedback = getFeedback(Number(id.slice(RATE_COMMENT_BUTTON.length)));
    if (!feedback || feedback.raterId !== interaction.user.id) {
      await interaction.reply(resultReply("Feedback", "This isn't your rating.", true, { client: interaction.client, tone: "warning" }));
      return true;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${RATE_COMMENT_MODAL}${feedback.id}`)
        .setTitle("Add a comment")
        .addLabelComponents(
          new LabelBuilder()
            .setLabel("Comment")
            .setDescription("Staff see your comment without your name.")
            .setTextInputComponent(new TextInputBuilder().setCustomId("comment").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(MAX_COMMENT)),
        ),
    );
    return true;
  }

  const ctx = await resolveCtx(interaction);
  if (!ctx) return true;
  const { guild, member, runtime, t } = ctx;
  const { config, guildConfig } = runtime;

  if (id.startsWith(ROSTER_BUTTON)) {
    const action = id.slice(ROSTER_BUTTON.length);
    const allowed = isOnTeam(member, config.ranks) || (await hasPermission(guild.id, PLUGIN, "can_shift", member, guildConfig));
    if (!allowed) {
      await ephemeral(interaction, ctx, t("team_control.rosterNotStaff", "Only staff can clock in."), "warning");
      return true;
    }
    if (action === "in") {
      const result = await startShift(member, config, null);
      await ephemeral(interaction, ctx, result.ok ? t("team_control.clockedInShort", "You're on shift.") : result.error, result.ok ? "success" : "warning");
    } else if (action === "break") {
      const result = await toggleBreak(member, config);
      await ephemeral(
        interaction,
        ctx,
        result.ok ? (result.onBreak ? t("team_control.breakStartedShort", "You're on break.") : t("team_control.breakEnded", "Welcome back, your break is over.")) : result.error,
        result.ok ? "success" : "warning",
      );
    } else {
      const result = await endOwnShift(member, config);
      await ephemeral(
        interaction,
        ctx,
        result.ok ? (result.voided ? t("team_control.clockedOutVoidedShort", "You're off shift. It was too short to count.") : t("team_control.clockedOutShort", "You're off shift.")) : result.error,
        result.ok ? "success" : "warning",
      );
    }
    return true;
  }

  if (id.startsWith(`${TEAM_PREFIX}confirm:`) || id.startsWith(`${TEAM_PREFIX}cancel:`)) {
    const confirm = id.startsWith(`${TEAM_PREFIX}confirm:`);
    const token = id.slice(id.lastIndexOf(":") + 1);
    const pending = confirmations.get(token);
    if (!pending || pending.guildId !== guild.id || Date.now() - pending.at > CONFIRM_TTL_MS) {
      confirmations.delete(token);
      await interaction.update(resultEdit("Team", t("team_control.confirmExpired", "This confirmation expired. Run the command again."), { ...ctx.options, tone: "warning" }, []));
      return true;
    }
    if (pending.actorId !== member.id) {
      await ephemeral(interaction, ctx, t("team_control.notYourButton", "This button isn't for you."), "warning");
      return true;
    }
    confirmations.delete(token);
    if (!confirm) {
      await interaction.update(resultEdit("Team", t("team_control.cancelled", "Cancelled. Nothing was changed."), ctx.options, []));
      return true;
    }
    const flag = pending.type === "promotion" || pending.type === "demotion" ? "can_promote" : "can_discipline";
    if (!(await hasPermission(guild.id, PLUGIN, flag, member, guildConfig))) {
      await denied(interaction, ctx);
      return true;
    }
    await interaction.deferUpdate();
    const result = await runTeamAction(guild, runtime, resolveActor(member, member.id, guildConfig, config.ranks), pending);
    await interaction.editReply(
      resultEdit(
        "Team",
        result.ok ? [`<@${pending.targetId}> was ${describeAction(config, result.action)}.`, ...result.notes].join("\n") : result.error,
        { ...ctx.options, tone: result.ok ? "success" : "warning" },
        [],
      ),
    );
    return true;
  }

  if (id.startsWith(LEAVE_BUTTON)) {
    const [action, leaveId] = id.slice(LEAVE_BUTTON.length).split(":");
    if (!(await hasPermission(guild.id, PLUGIN, "can_review_leave", member, guildConfig))) {
      await denied(interaction, ctx);
      return true;
    }
    const leave = getLeave(guild.id, Number(leaveId));
    if (!leave) {
      await ephemeral(interaction, ctx, t("team_control.leaveMissing", "That leave request no longer exists."), "warning");
      return true;
    }
    if (action === "deny") {
      await interaction.showModal(reasonModal(`${LEAVE_DENY_MODAL}${leave.id}`, "Deny leave request", "Reason (sent to the member)", false));
      return true;
    }
    await interaction.deferUpdate();
    const result = await decideLeave(interaction.client, guild, config, leave, member.id, true, null);
    if (!result.ok) await ephemeral(interaction, ctx, result.error, "warning");
    return true;
  }

  if (id.startsWith(TRIAL_BUTTON)) {
    const [action, userId] = id.slice(TRIAL_BUTTON.length).split(":") as [string, string];
    const flag = action === "pass" ? "can_promote" : action === "fail" ? "can_discipline" : "can_manage";
    if (!(await hasPermission(guild.id, PLUGIN, flag, member, guildConfig))) {
      await denied(interaction, ctx);
      return true;
    }
    const row = getTeamMember(guild.id, userId);
    if (!row || row.leftTeamAt || row.status !== "active") {
      await interaction.update(
        containerEdit(teamCard(interaction.client, guildConfig, "Trial review", `<@${userId}> is no longer on the team.`, { tone: "neutral" }), [trialReviewRow(userId, true)]),
      );
      return true;
    }
    if (action === "fail") {
      await interaction.showModal(reasonModal(`${TRIAL_FAIL_MODAL}${userId}`, "Fail trial and remove from team", "Reason (sent to the member)", config.actions.require_reason));
      return true;
    }
    if (action === "extend") {
      const base = Math.max(Date.now(), row.trialEndsAt?.getTime() ?? 0);
      const trialEndsAt = new Date(base + TRIAL_EXTEND_DAYS * 86_400_000);
      upsertTeamMember(guild.id, userId, { trialEndsAt, trialReviewedAt: null });
      await interaction.update(
        containerEdit(
          teamCard(interaction.client, guildConfig, "Trial extended", `<@${member.id}> extended <@${userId}>'s trial to <t:${Math.floor(trialEndsAt.getTime() / 1000)}:D>.`, { tone: "neutral" }),
          [trialReviewRow(userId, true)],
        ),
      );
      return true;
    }
    await interaction.deferUpdate();
    const result = await runTeamAction(guild, runtime, resolveActor(member, member.id, guildConfig, config.ranks), {
      targetId: userId,
      type: "promotion",
      reason: "Passed their trial",
    });
    if (!result.ok) {
      await ephemeral(interaction, ctx, result.error, "warning");
      return true;
    }
    upsertTeamMember(guild.id, userId, { trialEndsAt: null });
    await interaction.editReply(
      containerEdit(
        teamCard(interaction.client, guildConfig, "Trial passed", `<@${member.id}> passed <@${userId}>'s trial: ${describeAction(config, result.action)}.`, { tone: "success" }),
        [trialReviewRow(userId, true)],
      ),
    );
    return true;
  }
  return false;
}

// ── Modals ───────────────────────────────────────────────────────────────────

export async function handleTeamModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith(TEAM_PREFIX)) return false;

  if (id.startsWith(RATE_COMMENT_MODAL)) {
    const feedback = getFeedback(Number(id.slice(RATE_COMMENT_MODAL.length)));
    if (!feedback || feedback.raterId !== interaction.user.id) {
      await interaction.reply(resultReply("Feedback", "This isn't your rating.", true, { client: interaction.client, tone: "warning" }));
      return true;
    }
    setFeedbackComment(feedback.id, cleanComment(interaction.fields.getTextInputValue("comment")));
    await interaction.reply(resultReply("Feedback", "Thanks, your comment was added.", true, { client: interaction.client, tone: "success" }));
    return true;
  }

  const ctx = await resolveCtx(interaction);
  if (!ctx) return true;
  const { guild, member, runtime, t } = ctx;
  const { config, guildConfig } = runtime;
  const reason = interaction.fields.getTextInputValue("reason")?.trim() ?? "";

  if (id.startsWith(LEAVE_REQUEST_MODAL)) {
    const [kind, days, startsIn] = id.slice(LEAVE_REQUEST_MODAL.length).split(":");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await requestLeave(interaction.client, guild, config, member.id, {
      kind: (kind === "ra" ? "ra" : "loa") as LeaveKind,
      days: Number(days),
      startsInDays: Number(startsIn),
      reason,
    });
    await interaction.editReply(
      resultEdit(
        "Team",
        result.ok
          ? result.leave.status === "pending"
            ? t("team_control.leaveRequested", "Your request is in. You'll get a DM when it's reviewed.")
            : t("team_control.leaveApproved", "Your leave is approved, from <t:{start}:D> to <t:{end}:D>.", {
                start: Math.floor(result.leave.startsAt.getTime() / 1000),
                end: Math.floor(result.leave.endsAt.getTime() / 1000),
              })
          : result.error,
        { ...ctx.options, tone: result.ok ? "success" : "warning" },
      ),
    );
    return true;
  }

  if (id.startsWith(LEAVE_DENY_MODAL)) {
    if (!(await hasPermission(guild.id, PLUGIN, "can_review_leave", member, guildConfig))) {
      await denied(interaction, ctx);
      return true;
    }
    const leave = getLeave(guild.id, Number(id.slice(LEAVE_DENY_MODAL.length)));
    if (!leave) {
      await ephemeral(interaction, ctx, t("team_control.leaveMissing", "That leave request no longer exists."), "warning");
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await decideLeave(interaction.client, guild, config, leave, member.id, false, reason || null);
    await interaction.editReply(
      resultEdit("Team", result.ok ? t("team_control.leaveDenied", "Denied. The member was told by DM.") : result.error, { ...ctx.options, tone: result.ok ? "success" : "warning" }),
    );
    return true;
  }

  if (id.startsWith(TRIAL_FAIL_MODAL)) {
    if (!(await hasPermission(guild.id, PLUGIN, "can_discipline", member, guildConfig))) {
      await denied(interaction, ctx);
      return true;
    }
    const userId = id.slice(TRIAL_FAIL_MODAL.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await runTeamAction(guild, runtime, resolveActor(member, member.id, guildConfig, config.ranks), {
      targetId: userId,
      type: "termination",
      reason: reason || "Didn't pass their trial",
    });
    await interaction.editReply(
      resultEdit("Team", result.ok ? t("team_control.trialFailed", "<@{id}> didn't pass their trial and was removed from the team.", { id: userId }) : result.error, {
        ...ctx.options,
        tone: result.ok ? "success" : "warning",
      }),
    );
    if (result.ok && interaction.message) {
      await interaction.message
        .edit(containerEdit(teamCard(interaction.client, guildConfig, "Trial failed", `<@${member.id}> failed <@${userId}>'s trial.`, { tone: "error" }), [trialReviewRow(userId, true)]) as Parameters<typeof interaction.message.edit>[0])
        .catch(() => null);
    }
    return true;
  }
  return false;
}
