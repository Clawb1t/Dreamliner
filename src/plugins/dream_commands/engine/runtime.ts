/**
 * The context a run carries, the friendly step error, and every lookup a step makes. All lookups
 * go through THIS guild only: members via guild.members, roles via guild.roles, channels via
 * fetchGuildChannel(guildId). An id from another server (typed, from an option, or produced by a
 * variable) simply isn't found and the step fails with a friendly message.
 */
import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type Role,
} from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { ActorInfo, PermName } from "../../../core/actorPermissions.js";
import { actorAboveHierarchy, permissionLabel } from "../../../core/actorPermissions.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";
import { LIMITS, type CommandProgram } from "./types.js";
import { extractSnowflake, interpolate, type VarStore } from "./vars.js";
import type { Responder } from "./responder.js";

/** A failure the runner sees, in plain words. */
export class StepError extends Error {
  constructor(message: string, readonly code: string = "step_failed") {
    super(message);
    this.name = "StepError";
  }
}

/** Ends the run on purpose (Stop step). `message` is shown to the runner when set. */
export class StopRun extends Error {
  constructor(readonly userMessage: string | null, readonly isError: boolean) {
    super(userMessage ?? "stopped");
    this.name = "StopRun";
  }
}

export type RunTrigger = "slash" | "button" | "select" | "form" | "wait";

export type RunCounters = { steps: number; api: number; creations: number; dms: number; waitedSeconds: number };

export type RunCtx = {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  commandName: string;
  program: CommandProgram;
  /** Whose permissions the command runs with (the last person who saved it). */
  builder: ActorInfo;
  builderId: string;
  /** The builder's member (null for a platform superuser who isn't in the server). */
  builderMember: GuildMember | null;
  runner: GuildMember;
  /** Channel the command was used in. */
  channelId: string;
  vars: VarStore;
  responder: Responder;
  counters: RunCounters;
  created: { channels: Set<string>; roles: Set<string> };
  /** Messages this run sent, by step id ("reply" = the first reply). */
  messages: Map<string, { channelId: string; messageId: string }>;
  /** User ids picked in user/member options (allowed as DM and moderation targets). */
  optionUserIds: Set<string>;
  trigger: RunTrigger;
  startedAt: number;
  deadline: number;
  rng: () => number;
  /** Hook for tests: replaces Discord-touching behaviour. */
  test?: boolean;
};

// ── Discord errors in plain words ───────────────────────────────────────────────────────────

const DISCORD_CODES: Record<number, string> = {
  10003: "That channel doesn't exist any more.",
  10007: "That person isn't in this server.",
  10008: "That message doesn't exist any more.",
  10011: "That role doesn't exist any more.",
  10013: "That user doesn't exist.",
  10026: "That user isn't banned.",
  30005: "This server has too many roles.",
  30007: "This channel has too many webhooks.",
  30013: "This server has too many channels.",
  30003: "This channel has too many pinned messages.",
  40060: "That was already done.",
  50001: "Dreamliner can't see that channel.",
  50007: "That person doesn't accept DMs from this server.",
  50013: "Dreamliner is missing a permission for that, or the target is above Dreamliner's highest role.",
  50024: "That can't be done in this kind of channel.",
  50034: "Messages older than 14 days can't be bulk deleted.",
  50035: "Discord rejected the values (check lengths and formats).",
  160004: "A thread already exists for that message.",
};

export function friendlyError(error: unknown): string {
  if (error instanceof StepError) return error.message;
  if (error instanceof DiscordAPIError) {
    const known = DISCORD_CODES[Number(error.code)];
    if (known) return known;
    if (error.status === 429) return "Discord is rate limiting this server. Try again in a moment.";
    return `Discord refused the request (${error.code}).`;
  }
  if (error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 429) {
    return "Discord is rate limiting this server. Try again in a moment.";
  }
  return "Something went wrong in this step.";
}

/** Counts one Discord API call against the run's cap. */
export function spendApi(ctx: RunCtx, calls = 1): void {
  ctx.counters.api += calls;
  if (ctx.counters.api > LIMITS.apiCalls) {
    throw new StepError(`This command made too many Discord requests in one run (max ${LIMITS.apiCalls}).`, "api_cap");
  }
}

/** Runs a Discord call, counting it and turning errors into friendly ones. */
export async function discordCall<T>(ctx: RunCtx, fn: () => Promise<T>, calls = 1): Promise<T> {
  spendApi(ctx, calls);
  try {
    return await fn();
  } catch (error) {
    throw new StepError(friendlyError(error), "discord");
  }
}

export function checkDeadline(ctx: RunCtx): void {
  if (Date.now() > ctx.deadline) throw new StepError("This command took too long and was stopped.", "time_budget");
}

// ── Lookups (this guild only) ───────────────────────────────────────────────────────────────

/** Interpolates a target field (raw mode) and pulls a snowflake out of it. */
export function targetId(ctx: RunCtx, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return extractSnowflake(interpolate(value, ctx.vars, { mode: "raw", rng: ctx.rng }));
}

export async function resolveMember(ctx: RunCtx, value: unknown, what = "person"): Promise<GuildMember> {
  const id = targetId(ctx, value);
  if (!id) throw new StepError(`No ${what} was given for this step.`, "no_target");
  if (id === ctx.runner.id) return ctx.runner;
  const cached = ctx.guild.members.cache.get(id);
  if (cached) return cached;
  spendApi(ctx);
  const member = await ctx.guild.members.fetch(id).catch(() => null);
  if (!member) throw new StepError(`That ${what} isn't a member of this server.`, "foreign_member");
  return member;
}

export function resolveRole(ctx: RunCtx, value: unknown): Role {
  const id = targetId(ctx, value);
  if (!id) throw new StepError("No role was given for this step.", "no_target");
  const role = ctx.guild.roles.cache.get(id);
  if (!role) throw new StepError("That role isn't a role in this server.", "foreign_role");
  return role;
}

export async function resolveChannel(ctx: RunCtx, value: unknown): Promise<GuildBasedChannel> {
  const id = targetId(ctx, value);
  if (!id) throw new StepError("No channel was given for this step.", "no_target");
  const cached = ctx.guild.channels.cache.get(id);
  if (cached) return cached;
  spendApi(ctx);
  const channel = await fetchGuildChannel(ctx.client, ctx.guild.id, id);
  if (!channel || !("guildId" in channel) || channel.guildId !== ctx.guild.id) {
    throw new StepError("That channel isn't a channel in this server.", "foreign_channel");
  }
  return channel as GuildBasedChannel;
}

export async function resolveTextChannel(ctx: RunCtx, value: unknown) {
  const channel = await resolveChannel(ctx, value);
  if (!channel.isTextBased() || !("send" in channel)) throw new StepError(`#${channel.name} isn't a channel messages can be sent in.`);
  return channel;
}

/** A message this run sent (by step id or "reply"), fetched from its channel in this guild. */
export async function resolveRunMessage(ctx: RunCtx, ref: unknown): Promise<Message> {
  const key = typeof ref === "string" && ref ? ref : "reply";
  const entry = ctx.messages.get(key);
  if (!entry) throw new StepError(key === "reply" ? "There's no reply to use yet. Put a Reply step before this one." : "That step hasn't sent a message in this run.");
  const channel = await resolveTextChannel(ctx, entry.channelId);
  return discordCall(ctx, () => channel.messages.fetch(entry.messageId));
}

// ── Hierarchy and permissions ───────────────────────────────────────────────────────────────

export function botMember(ctx: RunCtx): GuildMember {
  const me = ctx.guild.members.me;
  if (!me) throw new StepError("Dreamliner couldn't load its own member in this server.");
  return me;
}

export function requireBotPermission(ctx: RunCtx, perm: PermName, channel?: GuildBasedChannel | null): void {
  const me = botMember(ctx);
  const has = channel && "permissionsFor" in channel ? channel.permissionsFor(me)?.has(PermissionFlagsBits[perm]) : me.permissions.has(PermissionFlagsBits[perm]);
  if (!has) throw new StepError(`Dreamliner needs ${permissionLabel(perm)}${channel ? ` in #${channel.name}` : ""} for this step.`, "bot_permission");
}

/** The builder must be able to do this in that channel too (channel overwrites count). */
export function checkBuilderChannelPermission(ctx: RunCtx, channel: GuildBasedChannel, perm: PermName): void {
  if (ctx.builder.owner || ctx.builder.superuser || ctx.builder.administrator) return;
  if (!ctx.builderMember || !("permissionsFor" in channel)) throw new StepError("The person who saved this command isn't in the server any more.");
  const perms = channel.permissionsFor(ctx.builderMember);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits[perm])) {
    throw new StepError(`The person who saved this command can't ${permissionLabel(perm).toLowerCase()} in #${channel.name}, so this command can't either.`, "builder_channel");
  }
}

/** Dreamliner and the builder can both hand out / edit this role. */
export function checkRoleManageable(ctx: RunCtx, role: Role): void {
  if (role.id === ctx.guild.id) throw new StepError("@everyone can't be given or taken.");
  if (role.managed) throw new StepError(`@${role.name} is managed by an integration.`);
  requireBotPermission(ctx, "ManageRoles");
  if (role.position >= botMember(ctx).roles.highest.position) {
    throw new StepError(`@${role.name} is above Dreamliner's highest role. Move Dreamliner's role higher in Server Settings.`, "bot_hierarchy");
  }
  if (!actorAboveHierarchy(ctx.builder) && role.position >= ctx.builder.highestPosition) {
    throw new StepError(`@${role.name} is at or above the highest role of the person who saved this command.`, "builder_hierarchy");
  }
  if (!actorAboveHierarchy(ctx.builder) && (role.permissions.bitfield & ~ctx.builder.permissions) !== 0n && !ctx.builder.administrator) {
    throw new StepError(`@${role.name} has permissions the person who saved this command doesn't have.`, "builder_hierarchy");
  }
}

/**
 * For actions done TO a member (kick, ban, timeout, nickname...): Dreamliner and the builder must
 * outrank them, and nobody can act on the owner.
 */
export function checkMemberActionable(ctx: RunCtx, target: GuildMember, verb: string): void {
  if (target.id === ctx.guild.ownerId) throw new StepError(`The server owner can't be ${verb}.`);
  if (target.id === ctx.client.user?.id) throw new StepError(`Dreamliner can't be ${verb} by its own command.`);
  const me = botMember(ctx);
  if (target.roles.highest.position >= me.roles.highest.position) {
    throw new StepError(`${target.displayName} is at or above Dreamliner's highest role, so they can't be ${verb}.`, "bot_hierarchy");
  }
  if (!actorAboveHierarchy(ctx.builder) && target.id !== ctx.builder.userId && target.roles.highest.position >= ctx.builder.highestPosition) {
    throw new StepError(`${target.displayName} is at or above the person who saved this command, so they can't be ${verb}.`, "builder_hierarchy");
  }
}

/** Moderation steps: the RUNNER must hold the permission too, and outrank the target. */
export function checkRunnerModerates(ctx: RunCtx, perm: PermName, target: GuildMember | null, verb: string): void {
  const runner = ctx.runner;
  const isOwner = runner.id === ctx.guild.ownerId;
  if (!isOwner && !runner.permissions.has(PermissionFlagsBits[perm])) {
    throw new StepError(`You need ${permissionLabel(perm)} to use this.`, "runner_permission");
  }
  if (target && !isOwner && target.id !== runner.id && target.roles.highest.position >= runner.roles.highest.position) {
    throw new StepError(`${target.displayName} is at or above your highest role, so you can't have them ${verb}.`, "runner_hierarchy");
  }
}

/** Only the runner or a person picked in a user/member option may be a target. */
export function checkOptionTarget(ctx: RunCtx, target: GuildMember | { id: string }, allowRunner: boolean): void {
  if (target.id === ctx.runner.id && allowRunner) return;
  if (ctx.optionUserIds.has(target.id)) return;
  throw new StepError("This step can only target the person picked in the command's options.", "target_not_option");
}

export const CHANNEL_KIND_TYPES: Record<string, ChannelType> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};

export function channelKindName(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return "thread";
    default:
      return "other";
  }
}
