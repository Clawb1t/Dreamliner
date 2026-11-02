import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ContextMenuCommandBuilder,
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type GuildMember,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { embedField, type ResultContainer } from "../../core/embeds.js";
import { hasPermission } from "../../core/permissionRoles.js";
import { containerReply, deferReplyOptions, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { neutralizeMentions } from "../../core/templates.js";
import type { ContextMenuCommandDefinition, SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import { describeAction, voidTeamAction } from "./functions/actions.js";
import { ACTION_LABELS, formatMinutes, LEAVE_LABELS, MAX_NOTE, MAX_REASON, PLUGIN, unix, type LeaveKind, type TeamActionType } from "./functions/config.js";
import { createConfirmation, runTeamAction } from "./functions/interactions.js";
import { endLeaveRecord, LEAVE_REQUEST_MODAL } from "./functions/leave.js";
import { loadTeamRuntime, syncGuildTeam } from "./functions/members.js";
import { teamCard } from "./functions/messages.js";
import { checklistProgress, checklistText } from "./functions/onboarding.js";
import { periodLabel, periodRange, parseWhich } from "./functions/periods.js";
import { buildProfileCard, quotaText } from "./functions/profile.js";
import { isOnTeam, memberRankIndex, resolveActor } from "./functions/ranks.js";
import { buildReportCard, reportFor } from "./functions/reports.js";
import { syncRoster } from "./functions/roster.js";
import { rateDirect, STARS } from "./functions/feedback.js";
import { allowedShiftTypes, endOwnShift, shiftTypeName, startShift, toggleBreak } from "./functions/shifts.js";
import { shiftWorkedSeconds } from "./functions/shiftMath.js";
import { getActiveShift, getOpenLeave, getTeamMember, insertNote, listLeaveByStatus, setOnboardingItem } from "./functions/store.js";
import { summarizeMember, summarizeTeam } from "./functions/team.js";

type Tone = "neutral" | "success" | "warning" | "error";
type Runtime = NonNullable<Awaited<ReturnType<typeof loadTeamRuntime>>>;
type Auth = { member: GuildMember; runtime: Runtime; onTeam: boolean };

async function reply(ctx: SlashCommandContext, body: string, tone: Tone = "neutral", ephemeral = true): Promise<void> {
  const payload = resultReply(ctx.t("team_control.title", "Team"), body, ephemeral, slashResultOptions(ctx, { tone }));
  if (ctx.interaction.deferred || ctx.interaction.replied) await ctx.interaction.editReply(payload as Parameters<typeof ctx.interaction.editReply>[0]);
  else await ctx.interaction.reply(payload);
}

async function replyCard(ctx: SlashCommandContext, card: ResultContainer, ephemeral = true, rows?: ActionRowBuilder<MessageActionRowComponentBuilder>[]): Promise<void> {
  const payload = containerReply(card, ephemeral, rows);
  if (ctx.interaction.deferred || ctx.interaction.replied) await ctx.interaction.editReply(payload as Parameters<typeof ctx.interaction.editReply>[0]);
  else await ctx.interaction.reply(payload);
}

/**
 * The plugin's gate for every subcommand: on, in a server, and the member holds `flag` (team
 * members pass `teamFlag` checks without it: anyone holding a rank may shift and request leave).
 */
async function authorize(ctx: SlashCommandContext, flag: string | null, options: { teamPasses?: boolean } = {}): Promise<Auth | null> {
  const { interaction, t } = ctx;
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;
  if (!guild || !member || typeof member.roles === "undefined") {
    await reply(ctx, t("common.serverOnlyBody", "This command can only be used in a server."), "error");
    return null;
  }
  const runtime = await loadTeamRuntime(guild.id);
  if (!runtime) {
    await reply(ctx, t("common.pluginDisabledBody", "The **{plugin}** plugin is disabled for this server.", { plugin: "Team Control" }), "error");
    return null;
  }
  const onTeam = isOnTeam(member, runtime.config.ranks);
  if (flag && !(options.teamPasses && onTeam) && !(await hasPermission(guild.id, PLUGIN, flag, member, runtime.guildConfig))) {
    await reply(ctx, t("common.noPermission", "You do not have permission to use this command."), "error");
    return null;
  }
  return { member, runtime, onTeam };
}

async function noRanksNote(ctx: SlashCommandContext, auth: Auth): Promise<boolean> {
  if (auth.runtime.config.ranks.some((rank) => rank.role_id)) return false;
  await reply(ctx, ctx.t("team_control.noRanks", "This server hasn't set up its staff ranks yet. Add them on the dashboard under Team Control."), "warning");
  return true;
}

const PERIOD_CHOICES = [
  { name: "This period", value: "current" },
  { name: "Last period", value: "previous" },
];

const userOpt = (required: boolean, description = "Staff member") => (o: import("discord.js").SlashCommandUserOption) =>
  o.setName("user").setDescription(description).setRequired(required);
const reasonOpt = (required: boolean) => (o: import("discord.js").SlashCommandStringOption) =>
  o.setName("reason").setDescription("Reason (shown to the member and in the log)").setRequired(required).setMaxLength(MAX_REASON);

const data = new SlashCommandBuilder()
  .setName("team")
  .setDescription("Team Control: shifts, leave, staff actions, activity and profiles")
  .addSubcommandGroup((g) =>
    g
      .setName("shift")
      .setDescription("Clock in and out")
      .addSubcommand((s) =>
        s
          .setName("start")
          .setDescription("Clock in")
          .addStringOption((o) => o.setName("type").setDescription("Shift type").setAutocomplete(true)),
      )
      .addSubcommand((s) => s.setName("break").setDescription("Start or end a break"))
      .addSubcommand((s) => s.setName("end").setDescription("Clock out"))
      .addSubcommand((s) => s.setName("status").setDescription("Who's on shift, or one member's shift").addUserOption(userOpt(false)))
      .addSubcommand((s) =>
        s
          .setName("leaderboard")
          .setDescription("Most time on shift")
          .addStringOption((o) => o.setName("period").setDescription("Which period").addChoices(...PERIOD_CHOICES)),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("leave")
      .setDescription("Leave of absence and reduced activity")
      .addSubcommand((s) =>
        s
          .setName("request")
          .setDescription("Request leave")
          .addStringOption((o) =>
            o
              .setName("kind")
              .setDescription("Leave of absence (away) or reduced activity")
              .setRequired(true)
              .addChoices({ name: "Leave of absence (LOA)", value: "loa" }, { name: "Reduced activity (RA)", value: "ra" }),
          )
          .addIntegerOption((o) => o.setName("days").setDescription("How many days").setRequired(true).setMinValue(1).setMaxValue(365))
          .addIntegerOption((o) => o.setName("starts_in_days").setDescription("Start in this many days (default: now)").setMinValue(0).setMaxValue(60)),
      )
      .addSubcommand((s) => s.setName("status").setDescription("Your current or pending leave"))
      .addSubcommand((s) => s.setName("end").setDescription("End your leave early, or cancel a pending request"))
      .addSubcommand((s) => s.setName("list").setDescription("Pending and active leave (reviewers)")),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("action")
      .setDescription("Promotions, demotions and discipline")
      .addSubcommand((s) =>
        s
          .setName("promote")
          .setDescription("Promote a member (or add them to the team)")
          .addUserOption(userOpt(true, "Member"))
          .addStringOption((o) => o.setName("rank").setDescription("Rank (default: one up)").setAutocomplete(true))
          .addStringOption(reasonOpt(false)),
      )
      .addSubcommand((s) =>
        s
          .setName("demote")
          .setDescription("Demote a staff member")
          .addUserOption(userOpt(true))
          .addStringOption((o) => o.setName("rank").setDescription("Rank (default: one down)").setAutocomplete(true))
          .addStringOption(reasonOpt(false)),
      )
      .addSubcommand((s) => s.setName("warn").setDescription("Warn a staff member").addUserOption(userOpt(true)).addStringOption(reasonOpt(true)))
      .addSubcommand((s) => s.setName("strike").setDescription("Give a staff member a strike").addUserOption(userOpt(true)).addStringOption(reasonOpt(true)))
      .addSubcommand((s) =>
        s
          .setName("suspend")
          .setDescription("Suspend a staff member (their rank roles come back after)")
          .addUserOption(userOpt(true))
          .addIntegerOption((o) => o.setName("days").setDescription("How many days").setRequired(true).setMinValue(1).setMaxValue(365))
          .addStringOption(reasonOpt(true)),
      )
      .addSubcommand((s) => s.setName("terminate").setDescription("Remove someone from the team").addUserOption(userOpt(true)).addStringOption(reasonOpt(true)))
      .addSubcommand((s) =>
        s
          .setName("void")
          .setDescription("Void an action (kept on record, roles aren't changed back)")
          .addIntegerOption((o) => o.setName("id").setDescription("Action number from the log").setRequired(true).setMinValue(1))
          .addStringOption(reasonOpt(true)),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("onboarding")
      .setDescription("New staff checklists")
      .addSubcommand((s) => s.setName("view").setDescription("A member's onboarding checklist").addUserOption(userOpt(false)))
      .addSubcommand((s) =>
        s
          .setName("check")
          .setDescription("Tick (or untick) a checklist item")
          .addUserOption(userOpt(true))
          .addStringOption((o) => o.setName("item").setDescription("Checklist item").setRequired(true).setAutocomplete(true))
          .addBooleanOption((o) => o.setName("done").setDescription("Done (default) or not done")),
      ),
  )
  .addSubcommand((s) => s.setName("profile").setDescription("A staff profile").addUserOption(userOpt(false)))
  .addSubcommand((s) => s.setName("roster").setDescription("The team and who's on duty"))
  .addSubcommand((s) =>
    s
      .setName("activity")
      .setDescription("Activity and quota for a period")
      .addUserOption(userOpt(false))
      .addStringOption((o) => o.setName("period").setDescription("Which period").addChoices(...PERIOD_CHOICES)),
  )
  .addSubcommand((s) =>
    s
      .setName("report")
      .setDescription("Team activity report (managers)")
      .addStringOption((o) => o.setName("period").setDescription("Which period").addChoices(...PERIOD_CHOICES)),
  )
  .addSubcommand((s) =>
    s
      .setName("rate")
      .setDescription("Rate a staff member")
      .addUserOption((o) => o.setName("staff").setDescription("Staff member").setRequired(true))
      .addIntegerOption((o) => o.setName("rating").setDescription("1 to 5 stars").setRequired(true).setMinValue(1).setMaxValue(5))
      .addStringOption((o) => o.setName("comment").setDescription("Optional comment").setMaxLength(500)),
  )
  .addSubcommand((s) =>
    s
      .setName("note")
      .setDescription("Add a private manager note to a staff profile")
      .addUserOption(userOpt(true))
      .addStringOption((o) => o.setName("text").setDescription("The note").setRequired(true).setMaxLength(MAX_NOTE)),
  )
  .addSubcommand((s) => s.setName("sync").setDescription("Re-check every member's rank roles (managers)"));

async function profileReply(ctx: SlashCommandContext, auth: Auth, userId: string): Promise<void> {
  const { config, guildConfig, one } = auth.runtime;
  const guild = ctx.interaction.guild!;
  const self = userId === auth.member.id;
  if (!self && !(await hasPermission(guild.id, PLUGIN, "can_view_team", auth.member, guildConfig))) {
    await reply(ctx, ctx.t("common.noPermission", "You do not have permission to use this command."), "error");
    return;
  }
  await guild.members.fetch(userId).catch(() => null);
  const range = periodRange(config.activity.period, config.activity.week_start);
  const summary = summarizeMember(guild.id, config, range, one, userId);
  if (!summary) {
    await reply(ctx, self ? ctx.t("team_control.notOnTeamSelf", "You aren't on the team.") : ctx.t("team_control.notOnTeam", "<@{id}> isn't on the team.", { id: userId }), "warning");
    return;
  }
  const manager = await hasPermission(guild.id, PLUGIN, "can_manage", auth.member, guildConfig);
  await replyCard(ctx, buildProfileCard(ctx.client, guild, guildConfig, config, one, summary, range, { manager }));
}

export const teamControlCommands: SlashCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data,
    execute: async (ctx) => {
      const { interaction, t } = ctx;
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      // ── Shifts ──
      if (group === "shift") {
        if (sub === "status" || sub === "leaderboard") {
          const auth = await authorize(ctx, "can_view_team", { teamPasses: true });
          if (!auth) return;
          const { config, guildConfig, one } = auth.runtime;
          const guild = interaction.guild!;
          if (sub === "status") {
            const user = interaction.options.getUser("user");
            if (user) {
              const shift = getActiveShift(guild.id, user.id);
              await reply(
                ctx,
                shift
                  ? t("team_control.shiftStatusOn", "<@{id}> is {state} since <t:{time}:t> · {worked} worked{type}.", {
                      id: user.id,
                      state: shift.breakStartedAt ? "on break" : "on duty",
                      time: unix(shift.startedAt),
                      worked: formatMinutes(shiftWorkedSeconds(shift) / 60),
                      type: shift.typeId ? ` · ${shiftTypeName(config, shift.typeId)}` : "",
                    })
                  : t("team_control.shiftStatusOff", "<@{id}> isn't on shift.", { id: user.id }),
              );
              return;
            }
            const { listActiveShifts } = await import("./functions/store.js");
            const shifts = listActiveShifts(guild.id);
            const lines = shifts.slice(0, 40).map((s) => {
              const dot = s.breakStartedAt ? "🟡" : "🟢";
              const type = s.typeId ? ` · ${neutralizeMentions(shiftTypeName(config, s.typeId) ?? "")}` : "";
              return `${dot} <@${s.userId}> · ${formatMinutes(shiftWorkedSeconds(s) / 60)}${type}`;
            });
            await replyCard(
              ctx,
              teamCard(ctx.client, guildConfig, t("team_control.onShiftTitle", "On shift ({count})", { count: shifts.length }), lines.join("\n") || t("team_control.nobodyOnShift", "Nobody is on shift right now.")),
              ctx.ephemeral,
            );
            return;
          }
          const which = parseWhich(interaction.options.getString("period"));
          const range = periodRange(config.activity.period, config.activity.week_start, which);
          const members = summarizeTeam(guild.id, config, range, one)
            .filter((m) => m.metrics.shiftMinutes > 0)
            .sort((a, b) => b.metrics.shiftMinutes - a.metrics.shiftMinutes)
            .slice(0, 10);
          const medals = ["🥇", "🥈", "🥉"];
          const lines = members.map((m, i) => `${medals[i] ?? `**${i + 1}.**`} <@${m.userId}> · ${formatMinutes(m.metrics.shiftMinutes)}`);
          await replyCard(
            ctx,
            teamCard(ctx.client, guildConfig, t("team_control.leaderboardTitle", "Shift leaderboard · {period}", { period: periodLabel(range) }), lines.join("\n") || t("team_control.noShifts", "No shifts yet this period.")),
            ctx.ephemeral,
          );
          return;
        }
        const auth = await authorize(ctx, "can_shift", { teamPasses: true });
        if (!auth) return;
        const { config } = auth.runtime;
        if (sub === "start") {
          const types = allowedShiftTypes(config, auth.member);
          const typeId = interaction.options.getString("type") ?? (types.length === 1 ? types[0]!.id : null);
          const result = await startShift(auth.member, config, typeId);
          await reply(
            ctx,
            result.ok
              ? t("team_control.clockedIn", "You're on shift{type}. Use `/team shift end` to clock out.", {
                  type: result.shift.typeId ? ` (${neutralizeMentions(shiftTypeName(config, result.shift.typeId) ?? "")})` : "",
                })
              : result.error,
            result.ok ? "success" : "warning",
          );
          return;
        }
        if (sub === "break") {
          const result = await toggleBreak(auth.member, config);
          await reply(
            ctx,
            result.ok
              ? result.onBreak
                ? t("team_control.breakStarted", "You're on break. Run `/team shift break` again to get back to work.")
                : t("team_control.breakEnded", "Welcome back, your break is over.")
              : result.error,
            result.ok ? "success" : "warning",
          );
          return;
        }
        const result = await endOwnShift(auth.member, config);
        if (!result.ok) {
          await reply(ctx, result.error, "warning");
          return;
        }
        const worked = formatMinutes(shiftWorkedSeconds(result.shift) / 60);
        await reply(
          ctx,
          result.voided
            ? t("team_control.clockedOutVoided", "You're off shift. It was shorter than {min} minutes, so it doesn't count.", { min: config.shifts.min_minutes })
            : t("team_control.clockedOut", "You're off shift after **{worked}** (breaks: {breaks}).", { worked, breaks: formatMinutes(result.shift.breakSeconds / 60) }),
          result.voided ? "warning" : "success",
        );
        return;
      }

      // ── Leave ──
      if (group === "leave") {
        if (sub === "list") {
          const auth = await authorize(ctx, "can_review_leave");
          if (!auth) return;
          const guild = interaction.guild!;
          const { rows } = listLeaveByStatus(guild.id, ["pending", "approved", "active"], 25);
          const lines = rows.map(
            (l) =>
              `\`#${l.id}\` <@${l.userId}> · ${LEAVE_LABELS[l.kind as LeaveKind]} · <t:${unix(l.startsAt)}:d> → <t:${unix(l.endsAt)}:d> · **${l.status}**`,
          );
          await replyCard(
            ctx,
            teamCard(ctx.client, auth.runtime.guildConfig, t("team_control.leaveListTitle", "Leave"), lines.join("\n") || t("team_control.leaveListEmpty", "No pending or active leave."), {
              footer: t("team_control.leaveListFooter", "Approve or deny requests from the review message or the dashboard."),
            }),
          );
          return;
        }
        const auth = await authorize(ctx, "can_request_leave", { teamPasses: true });
        if (!auth) return;
        const { config } = auth.runtime;
        const guild = interaction.guild!;
        if (!config.leave.enabled) {
          await reply(ctx, t("team_control.leaveOff", "Leave requests are turned off on this server."), "warning");
          return;
        }
        if (sub === "request") {
          const kind = interaction.options.getString("kind", true) as LeaveKind;
          const days = interaction.options.getInteger("days", true);
          const startsIn = interaction.options.getInteger("starts_in_days") ?? 0;
          if (days < config.leave.min_days || days > config.leave.max_days) {
            await reply(ctx, t("team_control.leaveDays", "Leave must be between {min} and {max} days.", { min: config.leave.min_days, max: config.leave.max_days }), "warning");
            return;
          }
          if (getOpenLeave(guild.id, auth.member.id)) {
            await reply(ctx, t("team_control.leaveOpen", "You already have a leave request that's pending or running. End or cancel it first."), "warning");
            return;
          }
          const modal = new ModalBuilder()
            .setCustomId(`${LEAVE_REQUEST_MODAL}${kind}:${days}:${startsIn}`)
            .setTitle(`${LEAVE_LABELS[kind]} · ${days} day${days === 1 ? "" : "s"}`.slice(0, 45))
            .addLabelComponents(
              new LabelBuilder()
                .setLabel("Reason")
                .setDescription(config.leave.require_reason ? "Required. Reviewers see this." : "Optional. Reviewers see this.")
                .setTextInputComponent(
                  new TextInputBuilder()
                    .setCustomId("reason")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(config.leave.require_reason)
                    .setMaxLength(MAX_REASON),
                ),
            );
          await interaction.showModal(modal);
          return;
        }
        const open = getOpenLeave(guild.id, auth.member.id);
        if (sub === "status") {
          await reply(
            ctx,
            open
              ? t("team_control.leaveStatus", "{kind} from <t:{start}:D> to <t:{end}:D> · **{status}**", {
                  kind: LEAVE_LABELS[open.kind as LeaveKind],
                  start: unix(open.startsAt),
                  end: unix(open.endsAt),
                  status: open.status,
                })
              : t("team_control.leaveNone", "You have no pending or running leave. Request some with `/team leave request`."),
          );
          return;
        }
        if (!open) {
          await reply(ctx, t("team_control.leaveNone", "You have no pending or running leave. Request some with `/team leave request`."), "warning");
          return;
        }
        const ended = await endLeaveRecord(guild, config, open, { by: auth.member.id });
        await reply(
          ctx,
          ended.status === "ended" ? t("team_control.leaveEnded", "Your leave is over. Welcome back!") : t("team_control.leaveCancelled", "Your leave request was cancelled."),
          "success",
        );
        return;
      }

      // ── Staff actions ──
      if (group === "action") {
        const flag = sub === "promote" || sub === "demote" ? "can_promote" : "can_discipline";
        const auth = await authorize(ctx, flag);
        if (!auth) return;
        if (await noRanksNote(ctx, auth)) return;
        const { config, guildConfig } = auth.runtime;
        const guild = interaction.guild!;
        const actor = resolveActor(auth.member, auth.member.id, guildConfig, config.ranks);
        if (sub === "void") {
          const result = await voidTeamAction(guild, config, actor, interaction.options.getInteger("id", true), interaction.options.getString("reason", true));
          await reply(
            ctx,
            result.ok
              ? [t("team_control.voided", "Voided {type} #{id} for <@{user}>.", { type: ACTION_LABELS[result.action.type as TeamActionType].toLowerCase(), id: result.action.id, user: result.action.userId }), ...result.notes].join("\n")
              : result.error,
            result.ok ? "success" : "warning",
          );
          return;
        }
        const user = interaction.options.getUser("user", true);
        const type: TeamActionType = ({ promote: "promotion", demote: "demotion", warn: "warning", strike: "strike", suspend: "suspension", terminate: "termination" } as const)[
          sub as "promote" | "demote" | "warn" | "strike" | "suspend" | "terminate"
        ];
        const request = {
          targetId: user.id,
          type,
          rankId: interaction.options.getString("rank"),
          reason: interaction.options.getString("reason") ?? "",
          days: interaction.options.getInteger("days"),
        };
        if (type === "termination" || type === "suspension") {
          const token = createConfirmation({ guildId: guild.id, actorId: auth.member.id, ...request });
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`team:confirm:${token}`)
              .setLabel(type === "termination" ? "Yes, remove them" : `Yes, suspend for ${request.days} days`)
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`team:cancel:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
          );
          const body =
            type === "termination"
              ? t("team_control.confirmTerminate", "Remove <@{id}> from the team? Their rank, duty, leave and suspended roles are taken off and any shift or leave ends.", { id: user.id })
              : t("team_control.confirmSuspend", "Suspend <@{id}> for **{days}** days? Their rank roles are taken off and given back when it ends.", { id: user.id, days: request.days ?? 0 });
          await interaction.reply(resultReply(t("team_control.confirmTitle", "Are you sure?"), body, true, slashResultOptions(ctx, { tone: "warning" }), [row]));
          return;
        }
        await interaction.deferReply(deferReplyOptions(true));
        const result = await runTeamAction(guild, auth.runtime, actor, request);
        await interaction.editReply(
          resultEdit(
            t("team_control.title", "Team"),
            result.ok ? [`<@${user.id}> was ${describeAction(config, result.action)}.`, ...result.notes].join("\n") : result.error,
            slashResultOptions(ctx, { tone: result.ok ? "success" : "warning" }),
          ),
        );
        return;
      }

      // ── Onboarding ──
      if (group === "onboarding") {
        const target = interaction.options.getUser("user") ?? interaction.user;
        const self = target.id === interaction.user.id;
        const auth = await authorize(ctx, sub === "check" || !self ? "can_manage" : null);
        if (!auth) return;
        const { config, guildConfig } = auth.runtime;
        const guild = interaction.guild!;
        if (!config.onboarding.enabled || config.onboarding.checklist.length === 0) {
          await reply(ctx, t("team_control.onboardingOff", "Onboarding checklists aren't set up on this server."), "warning");
          return;
        }
        if (sub === "check") {
          const itemId = interaction.options.getString("item", true);
          const item = config.onboarding.checklist.find((i) => i.id === itemId);
          if (!item) {
            await reply(ctx, t("team_control.noItem", "That checklist item doesn't exist."), "warning");
            return;
          }
          if (!getTeamMember(guild.id, target.id)) {
            await reply(ctx, t("team_control.notOnTeam", "<@{id}> isn't on the team.", { id: target.id }), "warning");
            return;
          }
          const done = interaction.options.getBoolean("done") ?? true;
          setOnboardingItem(guild.id, target.id, item.id, done, auth.member.id);
          const progress = checklistProgress(guild.id, target.id, config);
          await reply(
            ctx,
            t("team_control.itemChecked", "{state} **{item}** for <@{id}> · {done}/{total} done.", {
              state: done ? "Ticked" : "Unticked",
              item: neutralizeMentions(item.label),
              id: target.id,
              done: progress.done,
              total: progress.total,
            }),
            "success",
          );
          return;
        }
        const progress = checklistProgress(guild.id, target.id, config);
        const row = getTeamMember(guild.id, target.id);
        await replyCard(
          ctx,
          teamCard(ctx.client, guildConfig, t("team_control.onboardingTitle", "Onboarding · {done}/{total}", { done: progress.done, total: progress.total }), `<@${target.id}>\n${checklistText(progress)}`, {
            fields: row?.trialEndsAt ? [embedField("Trial ends", `<t:${unix(row.trialEndsAt)}:D> (<t:${unix(row.trialEndsAt)}:R>)`)] : [],
          }),
        );
        return;
      }

      // ── Everything else ──
      if (sub === "profile") {
        const auth = await authorize(ctx, null);
        if (!auth) return;
        await profileReply(ctx, auth, interaction.options.getUser("user")?.id ?? auth.member.id);
        return;
      }

      if (sub === "roster") {
        const auth = await authorize(ctx, "can_view_team", { teamPasses: true });
        if (!auth) return;
        const { buildRosterPayload } = await import("./functions/roster.js");
        const { payload } = buildRosterPayload(interaction.guild!, { ...auth.runtime.config, roster: { ...auth.runtime.config.roster, show_buttons: false } });
        await interaction.reply({ ...payload, flags: payload.flags | (ctx.ephemeral ? 64 : 0) });
        return;
      }

      if (sub === "activity") {
        const target = interaction.options.getUser("user") ?? interaction.user;
        const self = target.id === interaction.user.id;
        const auth = await authorize(ctx, self ? null : "can_view_team");
        if (!auth) return;
        const { config, guildConfig, one } = auth.runtime;
        const range = periodRange(config.activity.period, config.activity.week_start, parseWhich(interaction.options.getString("period")));
        const summary = summarizeMember(interaction.guild!.id, config, range, one, target.id);
        if (!summary) {
          await reply(ctx, self ? t("team_control.notOnTeamSelf", "You aren't on the team.") : t("team_control.notOnTeam", "<@{id}> isn't on the team.", { id: target.id }), "warning");
          return;
        }
        const m = summary.metrics;
        const fields = [
          embedField("Shift time", formatMinutes(m.shiftMinutes), true),
          embedField("Mod actions", String(m.modActions), true),
          embedField("Tickets closed", String(m.ticketsClosed), true),
          embedField("Staff messages", config.activity.staff_channel_ids.length ? String(m.staffMessages) : "Not tracked", true),
          embedField("Voice", formatMinutes(m.voiceMinutes), true),
        ];
        if (m.points !== null) fields.push(embedField("Points", String(m.points), true));
        fields.push(embedField("Quota", quotaText(summary)));
        await replyCard(
          ctx,
          teamCard(ctx.client, guildConfig, t("team_control.activityTitle", "Activity · {period}", { period: periodLabel(range) }), `<@${target.id}>`, { fields }),
        );
        return;
      }

      if (sub === "report") {
        const auth = await authorize(ctx, "can_manage");
        if (!auth) return;
        await interaction.deferReply(deferReplyOptions(ctx.ephemeral));
        const { config, guildConfig, one } = auth.runtime;
        const { range, members } = reportFor(interaction.guild!, config, one, parseWhich(interaction.options.getString("period")));
        await replyCard(ctx, buildReportCard(ctx.client, guildConfig, config, members, range), ctx.ephemeral);
        return;
      }

      if (sub === "rate") {
        const auth = await authorize(ctx, "can_rate");
        if (!auth) return;
        const staff = interaction.options.getUser("staff", true);
        const rating = interaction.options.getInteger("rating", true);
        const result = await rateDirect(interaction.guild!, auth.runtime.config, auth.member.id, staff.id, rating, interaction.options.getString("comment"), auth.onTeam);
        await reply(
          ctx,
          result.ok ? t("team_control.rated", "Thanks! You rated <@{id}> {stars}.", { id: staff.id, stars: STARS(rating) }) : result.error,
          result.ok ? "success" : "warning",
        );
        return;
      }

      if (sub === "note") {
        const auth = await authorize(ctx, "can_manage");
        if (!auth) return;
        const user = interaction.options.getUser("user", true);
        if (!getTeamMember(interaction.guild!.id, user.id)) {
          await reply(ctx, t("team_control.notOnTeam", "<@{id}> isn't on the team.", { id: user.id }), "warning");
          return;
        }
        insertNote(interaction.guild!.id, user.id, auth.member.id, interaction.options.getString("text", true).slice(0, MAX_NOTE));
        await reply(ctx, t("team_control.noteAdded", "Added a note to <@{id}>'s profile. Only managers can see it.", { id: user.id }), "success");
        return;
      }

      if (sub === "sync") {
        const auth = await authorize(ctx, "can_manage");
        if (!auth) return;
        if (await noRanksNote(ctx, auth)) return;
        await interaction.deferReply(deferReplyOptions(true));
        const count = await syncGuildTeam(interaction.guild!, auth.runtime.config, true);
        await syncRoster(ctx.client, interaction.guild!, auth.runtime.config, true).catch(() => false);
        await reply(ctx, t("team_control.synced", "Synced. **{count}** members are on the team.", { count }), "success");
        return;
      }
    },
  },
];

/** Autocomplete for rank, shift type and checklist item options. */
export async function handleTeamAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const runtime = guildId ? await loadTeamRuntime(guildId) : null;
  if (!runtime) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value).toLowerCase();
  const { config } = runtime;
  let choices: Array<{ name: string; value: string }> = [];
  if (focused.name === "rank") {
    const member = interaction.member as GuildMember | null;
    const mine = member && "roles" in member && typeof member.roles !== "string" ? memberRankIndex(member, config.ranks) : -1;
    choices = config.ranks
      .map((rank, i) => ({ name: `${rank.name}${i === mine ? " (your rank)" : ""}`, value: rank.id }))
      .reverse();
  } else if (focused.name === "type") {
    const member = interaction.member as GuildMember | null;
    const types = member && "roles" in member ? allowedShiftTypes(config, member) : config.shifts.types;
    choices = types.map((type) => ({ name: type.name, value: type.id }));
  } else if (focused.name === "item") {
    choices = config.onboarding.checklist.map((item) => ({ name: item.label, value: item.id }));
  }
  await interaction.respond(
    choices
      .filter((c) => !query || c.name.toLowerCase().includes(query) || c.value.includes(query))
      .slice(0, 25)
      .map((c) => ({ name: c.name.slice(0, 100), value: c.value })),
  );
}

export const teamControlContextMenus: ContextMenuCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data: new ContextMenuCommandBuilder().setName("Team profile").setType(ApplicationCommandType.User),
    execute: async (ctx) => {
      const { interaction, t } = ctx;
      if (!interaction.isUserContextMenuCommand() || !interaction.guild) return;
      const member = interaction.member as GuildMember | null;
      const runtime = await loadTeamRuntime(interaction.guild.id);
      const options = { client: ctx.client, emojis: ctx.guildConfig.emojis };
      if (!runtime || !member) {
        await interaction.reply(resultReply("Team", t("common.pluginDisabledBody", "The **{plugin}** plugin is disabled for this server.", { plugin: "Team Control" }), true, { ...options, tone: "error" }));
        return;
      }
      const target = interaction.targetUser;
      const { config, guildConfig, one } = runtime;
      if (target.id !== member.id && !(await hasPermission(interaction.guild.id, PLUGIN, "can_view_team", member, guildConfig))) {
        await interaction.reply(resultReply("Team", t("common.noPermission", "You do not have permission to use this command."), true, { ...options, tone: "error" }));
        return;
      }
      const range = periodRange(config.activity.period, config.activity.week_start);
      const summary = summarizeMember(interaction.guild.id, config, range, one, target.id);
      if (!summary) {
        await interaction.reply(resultReply("Team", t("team_control.notOnTeam", "<@{id}> isn't on the team.", { id: target.id }), true, { ...options, tone: "warning" }));
        return;
      }
      const manager = await hasPermission(interaction.guild.id, PLUGIN, "can_manage", member, guildConfig);
      await interaction.reply(containerReply(buildProfileCard(ctx.client, interaction.guild, guildConfig, config, one, summary, range, { manager }), true));
    },
  },
];
