import { ChannelType, OverwriteType, PermissionFlagsBits, type GuildBasedChannel, type OverwriteResolvable } from "discord.js";
import type { ActionDef } from "../action.js";
import { arr, bool, channelTargetField, num, str } from "../action.js";
import { countCreation } from "../limits.js";
import {
  botMember,
  CHANNEL_KIND_TYPES,
  channelKindName,
  checkBuilderChannelPermission,
  discordCall,
  requireBotPermission,
  resolveChannel,
  resolveRole,
  StepError,
  targetId,
  type RunCtx,
} from "../runtime.js";
import { interpolate } from "../vars.js";

const channelOutputs = [
  { key: "channel", label: "Channel mention" },
  { key: "channel.id", label: "Channel ID" },
  { key: "channel.name", label: "Channel name" },
  { key: "channel.url", label: "Channel link" },
];

function outputsFor(channel: GuildBasedChannel) {
  return {
    outputs: {
      channel: `<#${channel.id}>`,
      "channel.id": channel.id,
      "channel.name": channel.name,
      "channel.url": `https://discord.com/channels/${channel.guildId}/${channel.id}`,
    },
    trusted: ["channel", "channel.id", "channel.url"],
  };
}

/** Discord channel names: text-like channels are lowercase with dashes. */
export function cleanChannelName(raw: string, kind: string): string {
  let name = raw.replace(/[\u0000-\u001F]/g, "").trim();
  if (["text", "announcement", "forum"].includes(kind)) {
    name = name.toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").replace(/-{2,}/g, "-");
  }
  return name.slice(0, 100) || "new-channel";
}

const LOCK_PERMS = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads];

async function lockTarget(ctx: RunCtx, config: Record<string, unknown>) {
  const channel = await resolveChannel(ctx, config.channel);
  if (!("permissionOverwrites" in channel) || channel.isThread()) throw new StepError("That channel can't be locked.");
  requireBotPermission(ctx, "ManageRoles", channel);
  requireBotPermission(ctx, "ManageChannels", channel);
  checkBuilderChannelPermission(ctx, channel, "ManageChannels");
  checkBuilderChannelPermission(ctx, channel, "ManageRoles");
  const roleId = str(config, "role").trim() ? resolveRole(ctx, config.role).id : ctx.guild.id;
  if (roleId !== ctx.guild.id) {
    const role = ctx.guild.roles.cache.get(roleId)!;
    if (role.position >= botMember(ctx).roles.highest.position) throw new StepError(`@${role.name} is above Dreamliner's highest role.`);
  }
  return { channel, roleId };
}

export const channelActions: ActionDef[] = [
  {
    type: "create_channel",
    category: "channels",
    label: "Create a channel",
    description: "Make a new text, voice, forum or stage channel, or a category. Optionally private.",
    icon: "channel_add",
    fields: [
      { key: "name", label: "Name", kind: "text", required: true, maxLength: 100, variables: true },
      {
        key: "kind",
        label: "Type",
        kind: "select",
        options: [
          { value: "text", label: "Text" },
          { value: "voice", label: "Voice" },
          { value: "forum", label: "Forum" },
          { value: "announcement", label: "Announcement" },
          { value: "stage", label: "Stage" },
          { value: "category", label: "Category" },
        ],
      },
      { key: "parent", label: "Inside category", kind: "channel", channelTypes: ["category"], help: "Leave empty for no category.", showIf: { key: "kind", in: ["text", "voice", "forum", "announcement", "stage"] } },
      { key: "topic", label: "Topic", kind: "text", maxLength: 1024, variables: true, showIf: { key: "kind", in: ["text", "forum", "announcement"] } },
      { key: "slowmode", label: "Slowmode (seconds)", kind: "number", integer: true, min: 0, max: 21600, showIf: { key: "kind", in: ["text", "forum"] } },
      { key: "nsfw", label: "Age-restricted", kind: "boolean", showIf: { key: "kind", in: ["text", "forum", "voice"] } },
      { key: "private", label: "Private", kind: "boolean", help: "Hidden from everyone except the people below." },
      { key: "allowRunner", label: "Let the person who ran it see it", kind: "boolean", showIf: { key: "private", in: [true] } },
      { key: "allowRoles", label: "Roles that can see it", kind: "roles", maxItems: 10, showIf: { key: "private", in: [true] } },
    ],
    outputs: channelOutputs,
    defaults: { name: "{user.name}-room", kind: "text", parent: "", topic: "", slowmode: 0, nsfw: false, private: false, allowRunner: true, allowRoles: [] },
    summary: "Create a {kind} channel named {name}",
    creates: true,
    builderPerms: (c) => (c.private ? ["ManageChannels", "ManageRoles"] : ["ManageChannels"]),
    botPerms: (c) => (c.private ? ["ManageChannels", "ManageRoles"] : ["ManageChannels"]),
    run: async (ctx, config) => {
      const kind = str(config, "kind") || "text";
      const type = CHANNEL_KIND_TYPES[kind];
      if (type === undefined) throw new StepError("Unknown channel type.");
      requireBotPermission(ctx, "ManageChannels");
      const name = cleanChannelName(interpolate(str(config, "name"), ctx.vars, { mode: "raw", rng: ctx.rng }), kind);
      let parentId: string | undefined;
      if (kind !== "category" && str(config, "parent")) {
        const parent = await resolveChannel(ctx, config.parent);
        if (parent.type !== ChannelType.GuildCategory) throw new StepError("The parent must be a category.");
        checkBuilderChannelPermission(ctx, parent, "ManageChannels");
        parentId = parent.id;
      }
      const overwrites: OverwriteResolvable[] = [];
      if (bool(config, "private")) {
        requireBotPermission(ctx, "ManageRoles");
        const view = PermissionFlagsBits.ViewChannel;
        const talk = PermissionFlagsBits.SendMessages | PermissionFlagsBits.Connect | PermissionFlagsBits.ReadMessageHistory;
        overwrites.push({ id: ctx.guild.id, type: OverwriteType.Role, deny: view });
        overwrites.push({ id: botMember(ctx).id, type: OverwriteType.Member, allow: view | talk | PermissionFlagsBits.ManageChannels });
        if (bool(config, "allowRunner")) overwrites.push({ id: ctx.runner.id, type: OverwriteType.Member, allow: view | talk });
        for (const roleId of arr(config, "allowRoles").slice(0, 10)) {
          if (!ctx.guild.roles.cache.has(roleId)) throw new StepError("A role picked for this channel isn't in this server any more.");
          overwrites.push({ id: roleId, type: OverwriteType.Role, allow: view | talk });
        }
      }
      await countCreation(ctx, kind === "category" ? "channel" : "channel");
      const topic = interpolate(str(config, "topic"), ctx.vars, { mode: "raw", rng: ctx.rng }).slice(0, 1024);
      const channel = await discordCall(ctx, () =>
        ctx.guild.channels.create({
          name,
          type: type as ChannelType.GuildText,
          parent: parentId,
          topic: topic && ["text", "forum", "announcement"].includes(kind) ? topic : undefined,
          rateLimitPerUser: ["text", "forum"].includes(kind) ? Math.min(21600, Math.max(0, num(config, "slowmode"))) : undefined,
          nsfw: ["text", "forum", "voice"].includes(kind) ? bool(config, "nsfw") : undefined,
          permissionOverwrites: overwrites.length ? overwrites : undefined,
          reason: `Custom command /${ctx.commandName} used by ${ctx.runner.user.username}`,
        }),
      );
      ctx.created.channels.add(channel.id);
      return outputsFor(channel);
    },
  },
  {
    type: "edit_channel",
    category: "channels",
    label: "Edit a channel",
    description: "Rename a channel or change its topic, slowmode or age restriction.",
    icon: "channel_edit",
    fields: [
      channelTargetField("channel", "Channel"),
      { key: "name", label: "New name (empty keeps it)", kind: "text", maxLength: 100, variables: true },
      { key: "topic", label: "New topic (empty keeps it)", kind: "text", maxLength: 1024, variables: true },
      { key: "slowmode", label: "Slowmode seconds (-1 keeps it)", kind: "number", integer: true, min: -1, max: 21600 },
      { key: "nsfw", label: "Age-restricted", kind: "select", options: [{ value: "keep", label: "Keep as is" }, { value: "on", label: "On" }, { value: "off", label: "Off" }] },
    ],
    outputs: channelOutputs,
    defaults: { channel: "{channel.id}", name: "", topic: "", slowmode: -1, nsfw: "keep" },
    summary: "Edit {channel}",
    builderPerms: () => ["ManageChannels"],
    botPerms: () => ["ManageChannels"],
    run: async (ctx, config) => {
      const channel = await resolveChannel(ctx, config.channel);
      requireBotPermission(ctx, "ManageChannels", channel);
      checkBuilderChannelPermission(ctx, channel, "ManageChannels");
      const kind = channelKindName(channel.type);
      const edit: Record<string, unknown> = {};
      const name = interpolate(str(config, "name"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim();
      if (name) edit.name = cleanChannelName(name, kind);
      const topic = interpolate(str(config, "topic"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim();
      if (topic && ["text", "forum", "announcement"].includes(kind)) edit.topic = topic.slice(0, 1024);
      const slow = num(config, "slowmode", -1);
      if (slow >= 0 && ["text", "forum", "thread"].includes(kind)) edit.rateLimitPerUser = Math.min(21600, slow);
      if (config.nsfw === "on" || config.nsfw === "off") edit.nsfw = config.nsfw === "on";
      if (!Object.keys(edit).length) return outputsFor(channel);
      const updated = await discordCall(ctx, () => (channel as unknown as { edit(o: unknown): Promise<GuildBasedChannel> }).edit({ ...edit, reason: `Custom command /${ctx.commandName}` }));
      return outputsFor(updated);
    },
  },
  {
    type: "lock_channel",
    category: "channels",
    label: "Lock a channel",
    description: "Stop a role (everyone by default) from sending messages in a channel.",
    icon: "lock",
    fields: [channelTargetField("channel", "Channel", ["text", "announcement", "forum", "voice"]), { key: "role", label: "Role (empty = everyone)", kind: "role_target" }],
    outputs: [],
    defaults: { channel: "{channel.id}", role: "" },
    summary: "Lock {channel}",
    builderPerms: () => ["ManageChannels", "ManageRoles"],
    botPerms: () => ["ManageChannels", "ManageRoles"],
    run: async (ctx, config) => {
      const { channel, roleId } = await lockTarget(ctx, config);
      const deny = Object.fromEntries(LOCK_PERMS.map((p) => [Object.entries(PermissionFlagsBits).find(([, v]) => v === p)![0], false]));
      await discordCall(ctx, () => (channel as unknown as { permissionOverwrites: { edit(id: string, o: unknown, r: unknown): Promise<unknown> } }).permissionOverwrites.edit(roleId, deny, { reason: `Custom command /${ctx.commandName}` }));
    },
  },
  {
    type: "unlock_channel",
    category: "channels",
    label: "Unlock a channel",
    description: "Undo a lock: let the role send messages again.",
    icon: "unlock",
    fields: [channelTargetField("channel", "Channel", ["text", "announcement", "forum", "voice"]), { key: "role", label: "Role (empty = everyone)", kind: "role_target" }],
    outputs: [],
    defaults: { channel: "{channel.id}", role: "" },
    summary: "Unlock {channel}",
    builderPerms: () => ["ManageChannels", "ManageRoles"],
    botPerms: () => ["ManageChannels", "ManageRoles"],
    run: async (ctx, config) => {
      const { channel, roleId } = await lockTarget(ctx, config);
      const reset = Object.fromEntries(LOCK_PERMS.map((p) => [Object.entries(PermissionFlagsBits).find(([, v]) => v === p)![0], null]));
      await discordCall(ctx, () => (channel as unknown as { permissionOverwrites: { edit(id: string, o: unknown, r: unknown): Promise<unknown> } }).permissionOverwrites.edit(roleId, reset, { reason: `Custom command /${ctx.commandName}` }));
    },
  },
  {
    type: "delete_channel",
    category: "channels",
    label: "Delete a channel this run created",
    description: "Delete a channel or thread an earlier step of this same run created. Other channels can never be deleted.",
    icon: "channel_delete",
    fields: [{ key: "channel", label: "Channel", kind: "channel_target", required: true, help: "Only a channel created earlier in this run." }],
    outputs: [],
    defaults: { channel: "" },
    summary: "Delete {channel}",
    builderPerms: () => ["ManageChannels"],
    botPerms: () => ["ManageChannels"],
    validate: (config, v) => {
      const m = /^\{([a-z][a-z0-9_]{0,23})\.(channel|thread)\.id\}$/.exec(str(config, "channel").trim());
      const source = m ? v.earlier.find((s) => s.id === m[1]) : undefined;
      if (!source || !["create_channel", "clone_channel", "create_thread"].includes(source.type)) {
        v.issue("channel", "Pick a channel that an earlier Create channel, Clone channel or Create thread step makes.");
      }
    },
    run: async (ctx, config) => {
      const id = targetId(ctx, config.channel);
      if (!id || !ctx.created.channels.has(id)) throw new StepError("Only a channel created earlier in this run can be deleted.", "not_created_here");
      const channel = await resolveChannel(ctx, id);
      requireBotPermission(ctx, "ManageChannels", channel);
      await discordCall(ctx, async () => {
        await channel.delete(`Custom command /${ctx.commandName}`);
      });
      ctx.created.channels.delete(id);
    },
  },
  {
    type: "clone_channel",
    category: "channels",
    label: "Clone a channel",
    description: "Copy a channel with its settings and permissions.",
    icon: "clone",
    fields: [channelTargetField("channel", "Channel to copy"), { key: "name", label: "New name (empty keeps it)", kind: "text", maxLength: 100, variables: true }],
    outputs: channelOutputs,
    defaults: { channel: "", name: "" },
    summary: "Clone {channel}",
    creates: true,
    builderPerms: () => ["ManageChannels", "ManageRoles"],
    botPerms: () => ["ManageChannels", "ManageRoles"],
    run: async (ctx, config) => {
      const channel = await resolveChannel(ctx, config.channel);
      if (channel.isThread() || !("clone" in channel)) throw new StepError("Threads can't be cloned.");
      requireBotPermission(ctx, "ManageChannels", channel);
      checkBuilderChannelPermission(ctx, channel, "ManageChannels");
      await countCreation(ctx, "channel");
      const raw = interpolate(str(config, "name"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim();
      const clone = await discordCall(ctx, () =>
        (channel as unknown as { clone(o: unknown): Promise<GuildBasedChannel> }).clone({ name: raw ? cleanChannelName(raw, channelKindName(channel.type)) : undefined, reason: `Custom command /${ctx.commandName}` }),
      );
      ctx.created.channels.add(clone.id);
      return outputsFor(clone);
    },
  },
  {
    type: "create_invite",
    category: "channels",
    label: "Create an invite",
    description: "Make an invite link to a channel.",
    icon: "invite",
    fields: [
      channelTargetField("channel", "Channel", ["text", "voice", "announcement", "forum", "stage"]),
      { key: "maxAgeMinutes", label: "Expires after (minutes, 0 = never)", kind: "number", integer: true, min: 0, max: 10080 },
      { key: "maxUses", label: "Max uses (0 = unlimited)", kind: "number", integer: true, min: 0, max: 100 },
    ],
    outputs: [
      { key: "invite.url", label: "Invite link" },
      { key: "invite.code", label: "Invite code" },
    ],
    defaults: { channel: "{channel.id}", maxAgeMinutes: 60, maxUses: 1 },
    summary: "Create an invite to {channel}",
    builderPerms: () => ["CreateInstantInvite"],
    botPerms: () => ["CreateInstantInvite"],
    run: async (ctx, config) => {
      const channel = await resolveChannel(ctx, config.channel);
      if (!("createInvite" in channel)) throw new StepError("Invites can't be made for that channel.");
      requireBotPermission(ctx, "CreateInstantInvite", channel);
      checkBuilderChannelPermission(ctx, channel, "CreateInstantInvite");
      const invite = await discordCall(ctx, () =>
        (channel as unknown as { createInvite(o: unknown): Promise<{ url: string; code: string }> }).createInvite({
          maxAge: Math.max(0, num(config, "maxAgeMinutes", 60)) * 60,
          maxUses: Math.max(0, num(config, "maxUses", 1)),
          unique: true,
          reason: `Custom command /${ctx.commandName}`,
        }),
      );
      return { outputs: { "invite.url": invite.url, "invite.code": invite.code }, trusted: ["invite.url", "invite.code"] };
    },
  },
];
