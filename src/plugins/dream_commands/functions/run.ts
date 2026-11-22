/**
 * Running custom commands: the slash command itself, presses of buttons/menus it posted, form
 * submissions, and runs resumed after a long Wait. Every path does the same checks:
 *
 * 1. plugin on, command enabled, runner allowed (roles, permissions, channels), cooldowns, daily
 *    limits, per-server and per-user rate limits;
 * 2. the builder (last person who saved it) is still a member and still holds every permission
 *    the steps need, every picked id is still in this guild, Dreamliner has its permissions;
 * 3. then the interpreter runs with the step, time, API and creation caps.
 *
 * Nothing here throws to the caller: every failure becomes a friendly reply and a run record.
 */
import {
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { configManager as defaultConfigManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resultReply } from "../../../core/responses.js";
import { guildResultOptions } from "../../../core/embeds.js";
import { joinList, permissionLabel, resolveActor, type ActorInfo } from "../../../core/actorPermissions.js";
import { channelInList, guildChannelScope } from "../../../core/channelMatch.js";
import { getLogger } from "../../../core/logger.js";
import { getDreamCommand, setCommandHealth, type DreamCommandRow } from "./store.js";
import { isReservedCommandName } from "./guildSlash.js";
import { execute, firstReplyEphemeral, COMPONENT_PREFIX, type Continuation, type Frame, type RunOutcome, type FollowupState } from "../engine/interpreter.js";
import { InteractionResponder, ResumedResponder, type Responder } from "../engine/responder.js";
import type { RunCtx, RunTrigger } from "../engine/runtime.js";
import { botReport, builderReport, checkGuildIds, collectRequirements } from "../engine/permissions.js";
import { newVarStore, setVar, type VarStore } from "../engine/vars.js";
import { acquireRun, cooldownRemaining, dailyLimitProblem, recordDailyUse, startCooldown } from "../engine/limits.js";
import * as state from "../engine/state.js";
import { LIMITS, type CommandProgram, type Step } from "../engine/types.js";
import { resolveList } from "../engine/validate.js";
const log = getLogger("dream_commands");

const tsOf = (date: Date | null | undefined) => (date ? `<t:${Math.floor(date.getTime() / 1000)}:D>` : "");

// ── Variables ───────────────────────────────────────────────────────────────────────────────

export function addMemberVars(vars: VarStore, prefix: string, member: GuildMember): void {
  setVar(vars, prefix, member.user.username);
  setVar(vars, `${prefix}.name`, member.user.username);
  setVar(vars, `${prefix}.display_name`, member.displayName);
  setVar(vars, `${prefix}.mention`, `<@${member.id}>`, true);
  setVar(vars, `${prefix}.id`, member.id, true);
  setVar(vars, `${prefix}.avatar_url`, member.displayAvatarURL({ size: 512 }), true);
  setVar(vars, `${prefix}.bot`, member.user.bot);
  setVar(vars, `${prefix}.created_at`, tsOf(member.user.createdAt), true);
  setVar(vars, `${prefix}.joined_at`, tsOf(member.joinedAt), true);
}

const VERIFICATION = ["None", "Low", "Medium", "High", "Highest"];

export function baseVars(member: GuildMember, channelId: string, commandName: string, runs: number): VarStore {
  const vars = newVarStore();
  const guild = member.guild;
  addMemberVars(vars, "user", member);
  setVar(vars, "server", guild.name);
  setVar(vars, "server.name", guild.name);
  setVar(vars, "server.id", guild.id, true);
  setVar(vars, "server.icon_url", guild.iconURL({ size: 512 }) ?? "", true);
  setVar(vars, "server.owner", `<@${guild.ownerId}>`, true);
  setVar(vars, "server.owner_id", guild.ownerId, true);
  setVar(vars, "server.member_count", guild.memberCount);
  setVar(vars, "server.verification_level", VERIFICATION[guild.verificationLevel] ?? "");
  setVar(vars, "server.boosts", guild.premiumSubscriptionCount ?? 0);
  setVar(vars, "server.joined_at", tsOf(guild.joinedAt), true);
  const channel = guild.channels.cache.get(channelId);
  setVar(vars, "channel", `<#${channelId}>`, true);
  setVar(vars, "channel.id", channelId, true);
  setVar(vars, "channel.name", channel?.name ?? "");
  setVar(vars, "channel.type", channel ? String(channel.type) : "");
  setVar(vars, "command", commandName);
  setVar(vars, "runs", runs);
  return vars;
}

function restoreVars(saved: Continuation["vars"]): VarStore {
  const vars = newVarStore();
  for (const [k, v] of saved.values.slice(0, LIMITS.vars)) vars.values.set(k, v);
  for (const k of saved.trusted) vars.trusted.add(k);
  return vars;
}

/** Reads slash options into variables; member options must be members of THIS server. */
async function optionVars(interaction: ChatInputCommandInteraction, program: CommandProgram, vars: VarStore, optionUserIds: Set<string>): Promise<string | null> {
  for (const o of program.options) {
    const key = `option.${o.name}`;
    switch (o.type) {
      case "text": {
        const v = interaction.options.getString(o.name);
        if (v !== null) setVar(vars, key, v);
        break;
      }
      case "integer":
      case "number": {
        const v = o.type === "integer" ? interaction.options.getInteger(o.name) : interaction.options.getNumber(o.name);
        if (v !== null) setVar(vars, key, v);
        break;
      }
      case "boolean": {
        const v = interaction.options.getBoolean(o.name);
        if (v !== null) setVar(vars, key, v);
        break;
      }
      case "user":
      case "member": {
        const user = interaction.options.getUser(o.name);
        if (!user) break;
        const member = interaction.options.getMember(o.name);
        if (o.type === "member" && (!member || typeof member !== "object" || !("guild" in member))) return `${user.username} isn't a member of this server.`;
        if (member && typeof member === "object" && "guild" in member && (member as GuildMember).guild.id === interaction.guildId) {
          addMemberVars(vars, key, member as GuildMember);
        } else {
          setVar(vars, key, user.username);
          setVar(vars, `${key}.name`, user.username);
          setVar(vars, `${key}.mention`, `<@${user.id}>`, true);
          setVar(vars, `${key}.id`, user.id, true);
          setVar(vars, `${key}.avatar_url`, user.displayAvatarURL({ size: 512 }), true);
        }
        optionUserIds.add(user.id);
        break;
      }
      case "role": {
        const role = interaction.options.getRole(o.name);
        if (!role) break;
        if (!interaction.guild!.roles.cache.has(role.id)) return "That role isn't in this server.";
        setVar(vars, key, role.name);
        setVar(vars, `${key}.name`, role.name);
        setVar(vars, `${key}.id`, role.id, true);
        setVar(vars, `${key}.mention`, `<@&${role.id}>`, true);
        break;
      }
      case "channel": {
        const channel = interaction.options.getChannel(o.name);
        if (!channel) break;
        if (!interaction.guild!.channels.cache.has(channel.id) && !("guildId" in channel && channel.guildId === interaction.guildId)) return "That channel isn't in this server.";
        setVar(vars, key, `<#${channel.id}>`, true);
        setVar(vars, `${key}.name`, "name" in channel ? (channel.name ?? "") : "");
        setVar(vars, `${key}.id`, channel.id, true);
        setVar(vars, `${key}.mention`, `<#${channel.id}>`, true);
        break;
      }
      case "attachment": {
        const file = interaction.options.getAttachment(o.name);
        if (!file) break;
        setVar(vars, key, file.url, true);
        setVar(vars, `${key}.url`, file.url, true);
        setVar(vars, `${key}.name`, file.name);
        setVar(vars, `${key}.content_type`, file.contentType ?? "");
        break;
      }
    }
  }
  return null;
}

// ── Checks ──────────────────────────────────────────────────────────────────────────────────

/** Why the runner may not use this command (roles, permissions, channels), or null. */
export function accessProblem(program: CommandProgram, member: GuildMember, channelId: string): string | null {
  const a = program.access;
  const isOwner = member.id === member.guild.ownerId;
  if (a.blockedRoles.some((r) => member.roles.cache.has(r))) return "You can't use this command.";
  if (a.roles.length && !isOwner) {
    const ok = a.rolesMode === "all" ? a.roles.every((r) => member.roles.cache.has(r)) : a.roles.some((r) => member.roles.cache.has(r));
    if (!ok) {
      const names = a.roles.map((r) => member.guild.roles.cache.get(r)?.name).filter(Boolean) as string[];
      return `You need ${a.rolesMode === "all" ? "all of" : "one of"} these roles: ${joinList(names.map((n) => `@${n}`)) || "a required role"}.`;
    }
  }
  if (a.permissions.length && !isOwner) {
    const missing = a.permissions.filter((p) => p in PermissionFlagsBits && !member.permissions.has(PermissionFlagsBits[p as keyof typeof PermissionFlagsBits]));
    if (missing.length) return `You need ${joinList(missing.map(permissionLabel))} to use this command.`;
  }
  const scope = guildChannelScope(member.guild, channelId);
  if (a.blockedChannels.length && channelInList(a.blockedChannels, scope)) return "This command can't be used in this channel.";
  if (a.channels.length && !channelInList(a.channels, scope)) {
    const names = a.channels.slice(0, 5).map((c) => `<#${c}>`);
    return `This command only works in ${joinList(names)}.`;
  }
  return null;
}

type Prepared = { ok: true; builder: ActorInfo; builderMember: GuildMember | null } | { ok: false; title: string; message: string };

/** Re-checks the builder and Dreamliner right before running. Flags the command when the builder lost a permission. */
export async function prepareBuilder(command: DreamCommandRow, member: GuildMember): Promise<Prepared> {
  const guild = member.guild;
  const idIssues = checkGuildIds(guild, command.program);
  if (idIssues.length) {
    return { ok: false, title: "This command needs fixing", message: `${idIssues[0]!.message} Ask a server manager to open it on the dashboard and save it again.` };
  }
  const actor = await resolveActor(guild, command.lastEditorId);
  const req = collectRequirements(command.program);
  if (!actor) {
    setCommandHealth(guild.id, command.name, { status: "needs_resave", message: "The person who last saved this command is no longer in the server.", missing: [], at: new Date().toISOString() });
    return { ok: false, title: "This command needs re-saving", message: "The person who last saved this command left the server. Someone with the right permissions needs to save it again on the dashboard." };
  }
  const report = builderReport(guild, actor, req);
  if (report.missing.length || report.problems.length) {
    const what = report.missing.length ? joinList(report.missing) : "the right roles";
    setCommandHealth(guild.id, command.name, { status: "needs_resave", message: report.problems[0]?.message ?? `Needs ${what}.`, missing: report.missing, at: new Date().toISOString() });
    return { ok: false, title: "This command needs re-saving", message: `The person who last saved it no longer has ${what}. It needs re-saving by someone with ${what}.` };
  }
  if (command.health) setCommandHealth(guild.id, command.name, null);
  const bot = botReport(guild, req);
  if (bot.missing.length || bot.problems.length) {
    return { ok: false, title: "Dreamliner is missing a permission", message: bot.problems[0]?.message ?? `Dreamliner needs ${joinList(bot.missing)}.` };
  }
  const builderMember = guild.members.cache.get(actor.userId) ?? (await guild.members.fetch(actor.userId).catch(() => null));
  return { ok: true, builder: actor, builderMember };
}

// ── Running ─────────────────────────────────────────────────────────────────────────────────

function createCtx(input: {
  client: Client;
  guildConfig: GuildConfig;
  command: DreamCommandRow;
  builder: ActorInfo;
  builderMember: GuildMember | null;
  runner: GuildMember;
  channelId: string;
  vars: VarStore;
  responder: Responder;
  trigger: RunTrigger;
  continuation?: Continuation;
  optionUserIds?: Set<string>;
}): RunCtx {
  const c = input.continuation;
  return {
    client: input.client,
    guild: input.runner.guild,
    guildConfig: input.guildConfig,
    commandName: input.command.name,
    program: input.command.program,
    builder: input.builder,
    builderId: input.builder.userId,
    builderMember: input.builderMember,
    runner: input.runner,
    channelId: input.channelId,
    vars: input.vars,
    responder: input.responder,
    counters: c ? { ...c.counters } : { steps: 0, api: 0, creations: 0, dms: 0, waitedSeconds: 0 },
    created: { channels: new Set(c?.created.channels ?? []), roles: new Set(c?.created.roles ?? []) },
    messages: new Map(c?.messages ?? []),
    optionUserIds: input.optionUserIds ?? new Set(c?.optionUserIds ?? []),
    trigger: input.trigger,
    startedAt: Date.now(),
    deadline: Date.now() + LIMITS.runBudgetMs,
    rng: Math.random,
  };
}

function interpreterDeps(command: DreamCommandRow, ctxMeta: { trigger: string; startedAt: number }) {
  return {
    commandUpdatedAt: command.updatedAt.getTime(),
    saveFollowup: async (ctx: RunCtx, s: FollowupState, ttl: number) => state.saveFollowup(ctx.guild.id, ctx.commandName, s, ttl),
    attachFollowupMessage: async (id: string, messageId: string) => state.attachFollowupMessage(id, messageId),
    saveWait: async (ctx: RunCtx, continuation: Continuation, resumeAt: number) => {
      if (state.countJobs(ctx.guild.id) >= 100) throw new Error("Too many paused commands in this server.");
      state.saveJob(
        ctx.guild.id,
        ctx.commandName,
        {
          runnerId: ctx.runner.id,
          channelId: ctx.channelId,
          builderId: ctx.builderId,
          trigger: ctxMeta.trigger,
          startedAt: ctxMeta.startedAt,
          commandUpdatedAt: command.updatedAt.getTime(),
          token: ctx.responder.token(),
          continuation,
        },
        resumeAt,
      );
    },
  };
}

/** Shows the outcome to the runner and records the run. */
async function settle(ctx: RunCtx, outcome: RunOutcome, startedAt: number): Promise<void> {
  const responder = ctx.responder;
  let error: string | null = null;
  let failed: string | null = null;
  try {
    if (outcome.status === "ok") await responder.finish();
    else if (outcome.status === "stopped") {
      if (outcome.message) {
        if (outcome.isError) await responder.fail("Stopped", outcome.message);
        else await responder.send({ ...(resultReply(outcome.message, undefined, true, guildResultOptions(ctx.client, ctx.guildConfig, { tone: "neutral" })) as object), allowedMentions: { parse: [] } } as never, true);
      }
      await responder.finish();
    } else if (outcome.status === "error") {
      error = outcome.error;
      failed = outcome.stepId;
      await responder.fail(`/${ctx.commandName} couldn't finish`, outcome.error);
    }
  } catch (e) {
    log.warn(`[dream_commands] reply after /${ctx.commandName} failed:`, e);
  }
  state.recordRun({
    guildId: ctx.guild.id,
    commandName: ctx.commandName,
    userId: ctx.runner.id,
    channelId: ctx.channelId,
    trigger: ctx.trigger,
    status: outcome.status === "form" ? "waiting" : outcome.status,
    startedAt: new Date(startedAt),
    durationMs: Date.now() - startedAt,
    steps: ctx.counters.steps,
    failedStepId: failed,
    error: error ?? (outcome.warnings.length ? outcome.warnings.join("; ").slice(0, 500) : null),
  });
}

function refusal(interaction: RepliableInteraction, guildConfig: GuildConfig, title: string, message: string, tone: "error" | "warning" = "error") {
  const payload = resultReply(title, message, true, guildResultOptions(interaction.client, guildConfig, { tone }));
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
  return interaction.reply(payload).catch(() => null);
}

function recordRefusal(guildId: string, commandName: string, userId: string, channelId: string, trigger: string, reason: string): void {
  try {
    state.recordRun({ guildId, commandName, userId, channelId, trigger, status: "refused", startedAt: new Date(), durationMs: 0, steps: 0, failedStepId: null, error: reason });
  } catch {
    /* never block on history */
  }
}

async function usageCount(guildId: string, name: string): Promise<number> {
  try {
    const { getDreamCommandsUsage } = await import("./usage.js");
    return (await getDreamCommandsUsage(guildId, [name])).byName[name]?.total ?? 0;
  } catch {
    return 0;
  }
}

function firstActive(steps: Step[]): Step | undefined {
  return steps.find((s) => !s.disabled);
}

/**
 * Handles a guild-scoped custom slash command. Returns true when it was one of ours.
 */
export async function handleDreamCommandSlash(interaction: ChatInputCommandInteraction, configManager: ConfigManager = defaultConfigManager): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) return false;
  const command = await getDreamCommand(interaction.guildId, interaction.commandName);
  if (!command || !command.enabled || isReservedCommandName(command.name)) return false;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "dream_commands")) {
    await refusal(interaction, guildConfig, "Custom commands are off", "Custom commands are turned off in this server.");
    return true;
  }
  const member = interaction.member as GuildMember | null;
  if (!member || !("roles" in member) || typeof member.roles === "string" || !("cache" in member.roles)) {
    await refusal(interaction, guildConfig, "Try again", "Dreamliner couldn't load your member info.");
    return true;
  }
  const program = command.program;
  const deny = (title: string, message: string, tone: "error" | "warning" = "error") => {
    recordRefusal(interaction.guildId!, command.name, member.id, interaction.channelId, "slash", message);
    return refusal(interaction, guildConfig, title, message, tone);
  };

  const access = accessProblem(program, member, interaction.channelId);
  if (access) {
    await deny("You can't use this here", access);
    return true;
  }
  const wait = cooldownRemaining(interaction.guildId, command.name, member.id, interaction.channelId, program.cooldowns);
  if (wait > 0) {
    await deny("Slow down", `You can use /${command.name} again <t:${Math.floor(Date.now() / 1000) + wait}:R>.`, "warning");
    return true;
  }
  const daily = dailyLimitProblem(interaction.guildId, command.name, member.id, program.limits);
  if (daily) {
    await deny("Daily limit reached", daily, "warning");
    return true;
  }
  const slot = acquireRun(interaction.guildId, member.id);
  if (!slot.ok) {
    await deny("Slow down", slot.reason, "warning");
    return true;
  }

  const startedAt = Date.now();
  try {
    const responder = new InteractionResponder(interaction, interaction.client, guildConfig);
    const first = firstActive(program.steps);
    // A form must be the very first response, so it can't be deferred.
    if (first?.type !== "form") await responder.defer(firstReplyEphemeral(program.steps, program.ephemeral));

    const optionUserIds = new Set<string>();
    const vars = baseVars(member, interaction.channelId, command.name, await usageCount(interaction.guildId, command.name));
    const optionError = await optionVars(interaction, program, vars, optionUserIds);
    if (optionError) {
      await responder.fail("Can't use that option", optionError);
      recordRefusal(interaction.guildId, command.name, member.id, interaction.channelId, "slash", optionError);
      return true;
    }
    const prepared = await prepareBuilder(command, member);
    if (!prepared.ok) {
      await responder.fail(prepared.title, prepared.message);
      recordRefusal(interaction.guildId, command.name, member.id, interaction.channelId, "slash", prepared.message);
      return true;
    }
    startCooldown(interaction.guildId, command.name, member.id, interaction.channelId, program.cooldowns);
    recordDailyUse(interaction.guildId, command.name, member.id, program.limits);

    const ctx = createCtx({ client: interaction.client, guildConfig, command, builder: prepared.builder, builderMember: prepared.builderMember, runner: member, channelId: interaction.channelId, vars, responder, trigger: "slash", optionUserIds });
    const outcome = await execute(ctx, [{ block: null, key: "root", index: 0 }], interpreterDeps(command, { trigger: "slash", startedAt }));
    await settle(ctx, outcome, startedAt);

    const { trackCommandUsage } = await import("../../stats/functions/commandUsage.js");
    trackCommandUsage(interaction.guildId, command.name);
    log.info(`/${command.name} (custom) used by ${interaction.user.tag} in "${interaction.guild.name}" (${interaction.guildId}): ${outcome.status}`);
  } catch (error) {
    log.error(`[dream_commands] /${command.name} crashed:`, error);
    await refusal(interaction, guildConfig, `/${command.name} couldn't finish`, "Something went wrong. Try again in a moment.");
  } finally {
    slot.release();
  }
  return true;
}

// ── Autocomplete ────────────────────────────────────────────────────────────────────────────

export async function handleDreamCommandAutocomplete(interaction: AutocompleteInteraction): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guildId) return false;
  const command = await getDreamCommand(interaction.guildId, interaction.commandName);
  if (!command || !command.enabled) return false;
  const focused = interaction.options.getFocused(true);
  const option = command.program.options.find((o) => o.name === focused.name);
  const list = option?.autocomplete ?? [];
  const query = String(focused.value ?? "").toLowerCase();
  const matches = list.filter((item) => item.toLowerCase().includes(query)).slice(0, 25);
  await interaction.respond(matches.map((item) => ({ name: item.slice(0, 100), value: item.slice(0, 100) }))).catch(() => null);
  return true;
}

// ── Buttons, menus and forms ────────────────────────────────────────────────────────────────

export function isDreamCommandComponent(customId: string): boolean {
  return customId.startsWith(COMPONENT_PREFIX);
}

async function loadFollowupCommand(interaction: RepliableInteraction, guildConfig: GuildConfig, id: string): Promise<{ row: state.FollowupRow; command: DreamCommandRow } | null> {
  const lookup = state.getFollowup(id, interaction.guildId!);
  if (lookup.status !== "ok") {
    await refusal(interaction, guildConfig, "This has expired", lookup.status === "expired" ? "These buttons stopped working (they last 24 hours). Run the command again." : "This no longer works. Run the command again.", "warning");
    return null;
  }
  const command = await getDreamCommand(interaction.guildId!, lookup.row.commandName);
  if (!command || !command.enabled || !pluginEnabled(guildConfig, "dream_commands")) {
    await refusal(interaction, guildConfig, "This no longer works", "That command was turned off or removed.", "warning");
    return null;
  }
  if (command.updatedAt.getTime() > lookup.row.state.commandUpdatedAt + 1000) {
    await refusal(interaction, guildConfig, "This has expired", "The command was changed after this was sent. Run it again.", "warning");
    return null;
  }
  return { row: lookup.row, command };
}

export async function handleDreamCommandComponent(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!isDreamCommandComponent(interaction.customId)) return false;
  if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) return true;
  const guildConfig = await defaultConfigManager.getEffectiveConfig(interaction.guildId);
  const parts = interaction.customId.slice(COMPONENT_PREFIX.length).split(":");
  const kind = parts[0];
  const id = parts[1] ?? "";
  const loaded = await loadFollowupCommand(interaction, guildConfig, id);
  if (!loaded) return true;
  const { row, command } = loaded;
  const s = row.state;
  const member = interaction.member as GuildMember;

  let listKey: string;
  let blockId = s.blockId;
  let stack: Frame[];
  let trigger: RunTrigger;
  const vars = restoreVars(s.continuation.vars);

  if (kind === "f") {
    if (!interaction.isModalSubmit() || s.kind !== "form") return true;
    if (member.id !== s.runnerId) {
      await refusal(interaction, guildConfig, "Not your form", "Only the person who opened this form can send it.");
      return true;
    }
    for (const field of interaction.fields.fields.values()) {
      if ("value" in field && typeof field.value === "string") setVar(vars, `form.${field.customId}`, field.value.slice(0, 4000));
    }
    state.deleteFollowup(id);
    stack = s.continuation.stack;
    trigger = "form";
    listKey = "";
  } else {
    if (kind === "b" && !interaction.isButton()) return true;
    if (kind === "s" && !interaction.isStringSelectMenu()) return true;
    const itemId = kind === "b" ? (parts[2] ?? "") : interaction.isStringSelectMenu() ? (interaction.values[0] ?? "") : "";
    if (!/^[a-z0-9]{1,8}$/.test(itemId)) return true;
    if (s.who === "runner" && member.id !== s.runnerId) {
      await refusal(interaction, guildConfig, "Not for you", "Only the person who ran the command can use this.", "warning");
      return true;
    }
    if (s.who === "roles" && member.id !== interaction.guild.ownerId && !(s.roleIds ?? []).some((r) => member.roles.cache.has(r))) {
      await refusal(interaction, guildConfig, "Not for you", "You don't have a role that can use this.", "warning");
      return true;
    }
    if (!state.claimFollowup(id, s.singleUse === true)) {
      await refusal(interaction, guildConfig, "Already used", "This could only be used once.", "warning");
      return true;
    }
    listKey = kind === "b" ? `btn:${itemId}` : `opt:${itemId}`;
    blockId = s.blockId;
    setVar(vars, `${blockId}.${kind === "b" ? "pressed" : "picked"}`, s.labels?.[itemId] ?? itemId);
    stack = [{ block: blockId, key: listKey, index: 0 }];
    trigger = kind === "b" ? "button" : "select";
  }

  addMemberVars(vars, "press.user", member);
  const slot = acquireRun(interaction.guildId, member.id);
  if (!slot.ok) {
    await refusal(interaction, guildConfig, "Slow down", slot.reason, "warning");
    return true;
  }
  const startedAt = Date.now();
  try {
    const responder = new InteractionResponder(interaction, interaction.client, guildConfig);
    const list = listKey ? resolveList(command.program, blockId, listKey) : null;
    if (listKey && !list) {
      await responder.fail("This no longer works", "That choice was removed from the command.");
      return true;
    }
    const firstStep = list ? firstActive(list) : undefined;
    if (firstStep?.type !== "form") {
      const remaining = list ?? remainingSteps(command.program, stack);
      await responder.defer(firstReplyEphemeral(remaining, command.program.ephemeral));
    }
    // A press or form submit is run by the person who pressed (moderation steps check them).
    const runner = member;
    const prepared = await prepareBuilder(command, runner);
    if (!prepared.ok) {
      await responder.fail(prepared.title, prepared.message);
      recordRefusal(interaction.guildId, command.name, member.id, interaction.channelId ?? s.channelId, trigger, prepared.message);
      return true;
    }
    const ctx = createCtx({
      client: interaction.client,
      guildConfig,
      command,
      builder: prepared.builder,
      builderMember: prepared.builderMember,
      runner,
      channelId: interaction.channelId ?? s.channelId,
      vars,
      responder,
      trigger,
      continuation: s.continuation,
    });
    const outcome = await execute(ctx, stack, interpreterDeps(command, { trigger, startedAt }));
    await settle(ctx, outcome, startedAt);
  } catch (error) {
    log.error(`[dream_commands] follow-up for /${command.name} crashed:`, error);
    await refusal(interaction, guildConfig, "Something went wrong", "Try again in a moment.");
  } finally {
    slot.release();
  }
  return true;
}

function remainingSteps(program: CommandProgram, stack: Frame[]): Step[] {
  const top = stack[stack.length - 1];
  if (!top) return [];
  return (resolveList(program, top.block, top.key) ?? []).slice(top.index);
}

// ── Resuming after a Wait ───────────────────────────────────────────────────────────────────

export async function processDueDreamCommandJobs(client: Client): Promise<void> {
  const jobs = state.takeDueJobs(20);
  for (const job of jobs) {
    const s = job.state;
    const guild = client.guilds.cache.get(job.guildId);
    if (!guild) continue;
    const startedAt = Date.now();
    const fail = (reason: string) => recordRefusal(job.guildId, job.commandName, s.runnerId, s.channelId, "wait", reason);
    try {
      const guildConfig = await defaultConfigManager.getEffectiveConfig(guild.id);
      const command = await getDreamCommand(guild.id, job.commandName);
      if (!command || !command.enabled || !pluginEnabled(guildConfig, "dream_commands")) {
        fail("The command was turned off while it was waiting.");
        continue;
      }
      if (command.updatedAt.getTime() > s.commandUpdatedAt + 1000) {
        fail("The command was changed while it was waiting, so the rest didn't run.");
        continue;
      }
      const runner = await guild.members.fetch(s.runnerId).catch(() => null);
      if (!runner) {
        fail("The person who ran it left the server while it was waiting.");
        continue;
      }
      const prepared = await prepareBuilder(command, runner);
      if (!prepared.ok) {
        fail(prepared.message);
        continue;
      }
      const slot = acquireRun(guild.id, runner.id, Date.now());
      if (!slot.ok) {
        fail(slot.reason);
        continue;
      }
      try {
        const responder = new ResumedResponder(client, guild.id, s.channelId, guildConfig, s.token);
        const ctx = createCtx({
          client,
          guildConfig,
          command,
          builder: prepared.builder,
          builderMember: prepared.builderMember,
          runner,
          channelId: s.channelId,
          vars: restoreVars(s.continuation.vars),
          responder,
          trigger: "wait",
          continuation: s.continuation,
        });
        const outcome = await execute(ctx, s.continuation.stack, interpreterDeps(command, { trigger: "wait", startedAt }));
        await settle(ctx, outcome, startedAt);
      } finally {
        slot.release();
      }
    } catch (error) {
      log.error(`[dream_commands] resuming /${job.commandName} in ${job.guildId} failed:`, error);
      fail("Something went wrong when the command resumed.");
    }
  }
}

