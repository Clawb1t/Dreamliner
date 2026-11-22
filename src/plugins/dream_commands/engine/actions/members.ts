import { ChannelType, PermissionFlagsBits, type GuildMember } from "discord.js";
import type { PermName } from "../../../../core/actorPermissions.js";
import type { ActionDef } from "../action.js";
import { channelTargetField, num, reasonField, roleTargetField, str, userTargetField } from "../action.js";
import {
  checkMemberActionable,
  checkOptionTarget,
  checkRoleManageable,
  checkRunnerModerates,
  discordCall,
  requireBotPermission,
  resolveChannel,
  resolveMember,
  resolveRole,
  StepError,
  targetId,
  type RunCtx,
} from "../runtime.js";
import { interpolate } from "../vars.js";

function reason(ctx: RunCtx, config: Record<string, unknown>): string {
  const text = interpolate(str(config, "reason"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim();
  return `${text || `Used /${ctx.commandName}`} (by ${ctx.runner.user.username} via custom command)`.slice(0, 500);
}

/** Acting on someone other than the runner may need the runner's own permission too. */
function runnerNeedsFor(ctx: RunCtx, target: GuildMember, perm: PermName, verb: string): void {
  if (target.id !== ctx.runner.id) checkRunnerModerates(ctx, perm, target, verb);
}

const roleOutputs = [{ key: "changed", label: "Changed (true or false)" }];

function roleAction(type: "add_role" | "remove_role" | "toggle_role", label: string, description: string, icon: string, summary: string): ActionDef {
  return {
    type,
    category: "members",
    label,
    description,
    icon,
    fields: [roleTargetField("role", "Role"), userTargetField("Who")],
    outputs: type === "toggle_role" ? [...roleOutputs, { key: "added", label: "Added (true) or removed (false)" }] : roleOutputs,
    defaults: { role: "", target: "{user.id}" },
    summary,
    builderPerms: () => ["ManageRoles"],
    botPerms: () => ["ManageRoles"],
    grantRoleKeys: ["role"],
    run: async (ctx, config) => {
      const role = resolveRole(ctx, config.role);
      checkRoleManageable(ctx, role);
      const member = await resolveMember(ctx, config.target);
      const has = member.roles.cache.has(role.id);
      const add = type === "add_role" ? true : type === "remove_role" ? false : !has;
      if (add === has) return { outputs: { changed: false, added: add } };
      await discordCall(ctx, () => (add ? member.roles.add(role, `Custom command /${ctx.commandName}`) : member.roles.remove(role, `Custom command /${ctx.commandName}`)));
      return { outputs: { changed: true, added: add } };
    },
  };
}

function voiceToggle(type: "voice_mute" | "voice_deafen", label: string, perm: PermName, icon: string): ActionDef {
  const verb = type === "voice_mute" ? "muted" : "deafened";
  return {
    type,
    category: "members",
    label,
    description: `Server ${verb === "muted" ? "mute or unmute" : "deafen or undeafen"} someone in voice.`,
    icon,
    fields: [
      userTargetField(),
      { key: "mode", label: "Do", kind: "select", options: [{ value: "on", label: verb === "muted" ? "Mute" : "Deafen" }, { value: "off", label: verb === "muted" ? "Unmute" : "Undeafen" }, { value: "toggle", label: "Toggle" }] },
    ],
    outputs: [{ key: "state", label: "On after the step (true or false)" }],
    defaults: { target: "{user.id}", mode: "on" },
    summary: `${label}: {target}`,
    builderPerms: () => [perm],
    botPerms: () => [perm],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      runnerNeedsFor(ctx, member, perm, verb);
      if (!member.voice.channelId) throw new StepError(`${member.displayName} isn't in a voice channel.`);
      requireBotPermission(ctx, perm);
      const current = type === "voice_mute" ? Boolean(member.voice.serverMute) : Boolean(member.voice.serverDeaf);
      const next = config.mode === "toggle" ? !current : config.mode === "on";
      await discordCall(ctx, () => (type === "voice_mute" ? member.voice.setMute(next, `Custom command /${ctx.commandName}`) : member.voice.setDeaf(next, `Custom command /${ctx.commandName}`)));
      return { outputs: { state: next } };
    },
  };
}

const optionOnly = "Only a person picked in the command's options (not the person running it).";

export const memberActions: ActionDef[] = [
  roleAction("add_role", "Give a role", "Give a role to the person who ran it, or someone picked in an option.", "role_add", "Give {role} to {target}"),
  roleAction("remove_role", "Take a role", "Remove a role from the person who ran it, or someone picked in an option.", "role_remove", "Take {role} from {target}"),
  roleAction("toggle_role", "Toggle a role", "Give the role if they don't have it, take it if they do.", "role_toggle", "Toggle {role} for {target}"),
  {
    type: "set_nickname",
    category: "members",
    label: "Change nickname",
    description: "Set or reset someone's server nickname.",
    icon: "nickname",
    fields: [userTargetField(), { key: "nickname", label: "Nickname (empty resets it)", kind: "text", maxLength: 32, variables: true }],
    outputs: [],
    defaults: { target: "{user.id}", nickname: "" },
    summary: "Set the nickname of {target} to {nickname}",
    builderPerms: () => ["ManageNicknames"],
    botPerms: () => ["ManageNicknames"],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      runnerNeedsFor(ctx, member, "ManageNicknames", "renamed");
      checkMemberActionable(ctx, member, "renamed");
      const nick = interpolate(str(config, "nickname"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 32);
      await discordCall(ctx, () => member.setNickname(nick || null, `Custom command /${ctx.commandName}`));
    },
  },
  {
    type: "timeout",
    category: "members",
    label: "Time out",
    description: "Time out someone picked in an option. The person running it needs Timeout Members too.",
    icon: "timeout",
    fields: [userTargetField("Who", optionOnly), { key: "minutes", label: "Minutes", kind: "number", integer: true, min: 1, max: 40320, required: true }, reasonField],
    outputs: [{ key: "until", label: "Ends (Discord timestamp)" }],
    defaults: { target: "", minutes: 10, reason: "" },
    summary: "Time out {target} for {minutes} minutes",
    builderPerms: () => ["ModerateMembers"],
    botPerms: () => ["ModerateMembers"],
    runnerPerms: () => ["ModerateMembers"],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      checkOptionTarget(ctx, member, false);
      checkRunnerModerates(ctx, "ModerateMembers", member, "timed out");
      checkMemberActionable(ctx, member, "timed out");
      if (member.permissions.has(PermissionFlagsBits.Administrator)) throw new StepError("Administrators can't be timed out.");
      const ms = Math.min(40320, Math.max(1, num(config, "minutes", 10))) * 60_000;
      await discordCall(ctx, () => member.timeout(ms, reason(ctx, config)));
      return { outputs: { until: `<t:${Math.floor((Date.now() + ms) / 1000)}:R>` }, trusted: ["until"] };
    },
  },
  {
    type: "remove_timeout",
    category: "members",
    label: "Remove time out",
    description: "End someone's time out. The person running it needs Timeout Members too.",
    icon: "untimeout",
    fields: [userTargetField("Who", optionOnly), reasonField],
    outputs: [],
    defaults: { target: "", reason: "" },
    summary: "Remove the time out from {target}",
    builderPerms: () => ["ModerateMembers"],
    botPerms: () => ["ModerateMembers"],
    runnerPerms: () => ["ModerateMembers"],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      checkOptionTarget(ctx, member, false);
      checkRunnerModerates(ctx, "ModerateMembers", member, "un-timed out");
      checkMemberActionable(ctx, member, "un-timed out");
      await discordCall(ctx, () => member.timeout(null, reason(ctx, config)));
    },
  },
  {
    type: "kick",
    category: "members",
    label: "Kick",
    description: "Kick someone picked in an option. The person running it needs Kick Members too.",
    icon: "kick",
    fields: [userTargetField("Who", optionOnly), reasonField],
    outputs: [],
    defaults: { target: "", reason: "" },
    summary: "Kick {target}",
    builderPerms: () => ["KickMembers"],
    botPerms: () => ["KickMembers"],
    runnerPerms: () => ["KickMembers"],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      checkOptionTarget(ctx, member, false);
      checkRunnerModerates(ctx, "KickMembers", member, "kicked");
      checkMemberActionable(ctx, member, "kicked");
      await discordCall(ctx, () => member.kick(reason(ctx, config)));
    },
  },
  {
    type: "ban",
    category: "members",
    label: "Ban",
    description: "Ban someone picked in an option. The person running it needs Ban Members too.",
    icon: "ban",
    fields: [
      userTargetField("Who", optionOnly),
      reasonField,
      { key: "deleteDays", label: "Delete their messages from the last", kind: "select", options: [{ value: "0", label: "Don't delete" }, { value: "1", label: "1 day" }, { value: "7", label: "7 days" }] },
    ],
    outputs: [],
    defaults: { target: "", reason: "", deleteDays: "0" },
    summary: "Ban {target}",
    builderPerms: () => ["BanMembers"],
    botPerms: () => ["BanMembers"],
    runnerPerms: () => ["BanMembers"],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      checkOptionTarget(ctx, member, false);
      checkRunnerModerates(ctx, "BanMembers", member, "banned");
      checkMemberActionable(ctx, member, "banned");
      const days = Number(str(config, "deleteDays")) || 0;
      await discordCall(ctx, () => member.ban({ reason: reason(ctx, config), deleteMessageSeconds: Math.min(7, Math.max(0, days)) * 86400 }));
    },
  },
  {
    type: "unban",
    category: "members",
    label: "Unban",
    description: "Lift the ban of a user picked in an option. The person running it needs Ban Members too.",
    icon: "unban",
    fields: [{ key: "target", label: "Who", kind: "user_target", required: true, help: "A user option (banned people aren't members, so use a User option)." }, reasonField],
    outputs: [],
    defaults: { target: "", reason: "" },
    summary: "Unban {target}",
    builderPerms: () => ["BanMembers"],
    botPerms: () => ["BanMembers"],
    runnerPerms: () => ["BanMembers"],
    run: async (ctx, config) => {
      checkRunnerModerates(ctx, "BanMembers", null, "unbanned");
      const id = targetId(ctx, config.target);
      if (!id) throw new StepError("No user was given for this step.");
      checkOptionTarget(ctx, { id }, false);
      requireBotPermission(ctx, "BanMembers");
      // Only bans in THIS server are looked up or lifted.
      const ban = await discordCall(ctx, () => ctx.guild.bans.fetch(id).catch(() => null));
      if (!ban) throw new StepError("That user isn't banned in this server.");
      await discordCall(ctx, () => ctx.guild.bans.remove(id, reason(ctx, config)));
    },
  },
  {
    type: "move_voice",
    category: "members",
    label: "Move to voice channel",
    description: "Move someone who is in voice to another voice channel.",
    icon: "voice_move",
    fields: [userTargetField(), channelTargetField("channel", "Voice channel", ["voice", "stage"])],
    outputs: [],
    defaults: { target: "{user.id}", channel: "" },
    summary: "Move {target} to {channel}",
    builderPerms: () => ["MoveMembers"],
    botPerms: () => ["MoveMembers"],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      runnerNeedsFor(ctx, member, "MoveMembers", "moved");
      if (!member.voice.channelId) throw new StepError(`${member.displayName} isn't in a voice channel.`);
      const channel = await resolveChannel(ctx, config.channel);
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) throw new StepError("Pick a voice channel.");
      requireBotPermission(ctx, "MoveMembers", channel);
      await discordCall(ctx, () => member.voice.setChannel(channel.id, `Custom command /${ctx.commandName}`));
    },
  },
  {
    type: "disconnect_voice",
    category: "members",
    label: "Disconnect from voice",
    description: "Disconnect someone from their voice channel.",
    icon: "voice_off",
    fields: [userTargetField()],
    outputs: [],
    defaults: { target: "{user.id}" },
    summary: "Disconnect {target} from voice",
    builderPerms: () => ["MoveMembers"],
    botPerms: () => ["MoveMembers"],
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      runnerNeedsFor(ctx, member, "MoveMembers", "disconnected");
      if (!member.voice.channelId) throw new StepError(`${member.displayName} isn't in a voice channel.`);
      requireBotPermission(ctx, "MoveMembers");
      await discordCall(ctx, () => member.voice.disconnect(`Custom command /${ctx.commandName}`));
    },
  },
  voiceToggle("voice_mute", "Server mute", "MuteMembers", "mute"),
  voiceToggle("voice_deafen", "Server deafen", "DeafenMembers", "deafen"),
];
