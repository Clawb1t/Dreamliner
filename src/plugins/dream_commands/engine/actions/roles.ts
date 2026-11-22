import { ChannelType, PermissionFlagsBits, type Role } from "discord.js";
import type { PermName } from "../../../../core/actorPermissions.js";
import { actorGrantablePermissions, permissionLabel } from "../../../../core/actorPermissions.js";
import type { ActionDef } from "../action.js";
import { arr, bool, channelTargetField, roleTargetField, str } from "../action.js";
import { countCreation } from "../limits.js";
import { botMember, checkRoleManageable, discordCall, requireBotPermission, resolveChannel, resolveRole, StepError } from "../runtime.js";
import { LIMITS } from "../types.js";
import { interpolate } from "../vars.js";

/** Permissions a command may never put on a role it creates, whoever saved it. */
export const NEVER_GRANT: PermName[] = ["Administrator", "ManageGuild", "ManageRoles", "BanMembers", "KickMembers", "ManageWebhooks", "MentionEveryone"];

const roleOutputs = [
  { key: "role", label: "Role mention" },
  { key: "role.id", label: "Role ID" },
  { key: "role.name", label: "Role name" },
];

function outputsFor(role: Role) {
  return { outputs: { role: `<@&${role.id}>`, "role.id": role.id, "role.name": role.name }, trusted: ["role", "role.id"] };
}

export const roleActions: ActionDef[] = [
  {
    type: "create_role",
    category: "roles",
    label: "Create a role",
    description: "Make a new role at the bottom of the role list. It can only carry permissions you have yourself.",
    icon: "role_new",
    fields: [
      { key: "name", label: "Name", kind: "text", required: true, maxLength: 100, variables: true },
      { key: "color", label: "Colour", kind: "color" },
      { key: "hoist", label: "Show separately in the member list", kind: "boolean" },
      { key: "mentionable", label: "Anyone can mention it", kind: "boolean" },
      { key: "permissions", label: "Permissions", kind: "permissions", help: "Administrator, Manage Server, Manage Roles, Ban, Kick, Webhooks and Mention Everyone can't be added." },
    ],
    outputs: roleOutputs,
    defaults: { name: "{user.name}'s role", color: null, hoist: false, mentionable: false, permissions: [] },
    summary: "Create a role named {name}",
    creates: true,
    builderPerms: (c) => ["ManageRoles", ...(arr(c, "permissions") as PermName[])],
    botPerms: (c) => ["ManageRoles", ...(arr(c, "permissions") as PermName[])],
    validate: (config, v) => {
      const bad = arr(config, "permissions").filter((p) => NEVER_GRANT.includes(p as PermName));
      if (bad.length) v.issue("permissions", `${bad.map(permissionLabel).join(", ")} can't be given to a role a command creates.`);
    },
    run: async (ctx, config) => {
      requireBotPermission(ctx, "ManageRoles");
      const perms = arr(config, "permissions").filter((p): p is PermName => p in PermissionFlagsBits && !NEVER_GRANT.includes(p as PermName));
      let bits = 0n;
      for (const p of perms) bits |= PermissionFlagsBits[p];
      const lacking = bits & ~actorGrantablePermissions(ctx.builder);
      if (lacking) throw new StepError("The role would carry permissions the person who saved this command doesn't have.", "builder_permission");
      if (bits & ~botMember(ctx).permissions.bitfield) throw new StepError("The role would carry permissions Dreamliner doesn't have.");
      await countCreation(ctx, "role");
      const name = interpolate(str(config, "name"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 100) || "new role";
      const color = typeof config.color === "number" ? config.color : undefined;
      const role = await discordCall(ctx, () =>
        ctx.guild.roles.create({ name, colors: color !== undefined ? { primaryColor: color } : undefined, hoist: bool(config, "hoist"), mentionable: bool(config, "mentionable"), permissions: bits, reason: `Custom command /${ctx.commandName}` }),
      );
      ctx.created.roles.add(role.id);
      return outputsFor(role);
    },
  },
  {
    type: "edit_role",
    category: "roles",
    label: "Edit a role",
    description: "Rename a role or change its colour. Its permissions are never changed.",
    icon: "role_edit",
    fields: [
      roleTargetField("role", "Role"),
      { key: "name", label: "New name (empty keeps it)", kind: "text", maxLength: 100, variables: true },
      { key: "changeColor", label: "Change the colour", kind: "boolean" },
      { key: "color", label: "Colour", kind: "color", showIf: { key: "changeColor", in: [true] } },
    ],
    outputs: roleOutputs,
    defaults: { role: "", name: "", changeColor: false, color: null },
    summary: "Edit {role}",
    builderPerms: () => ["ManageRoles"],
    botPerms: () => ["ManageRoles"],
    grantRoleKeys: ["role"],
    run: async (ctx, config) => {
      const role = resolveRole(ctx, config.role);
      checkRoleManageable(ctx, role);
      const edit: Record<string, unknown> = {};
      const name = interpolate(str(config, "name"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim();
      if (name) edit.name = name.slice(0, 100);
      if (bool(config, "changeColor")) edit.colors = { primaryColor: typeof config.color === "number" ? config.color : 0 };
      if (!Object.keys(edit).length) return outputsFor(role);
      const updated = await discordCall(ctx, () => role.edit({ ...edit, reason: `Custom command /${ctx.commandName}` }));
      return outputsFor(updated);
    },
  },
  {
    type: "role_voice_members",
    category: "roles",
    label: "Role for everyone in voice",
    description: `Give or take a role from everyone in a voice channel (up to ${LIMITS.massMembers} people).`,
    icon: "role_voice",
    fields: [
      channelTargetField("channel", "Voice channel", ["voice", "stage"]),
      roleTargetField("role", "Role"),
      { key: "mode", label: "Do", kind: "select", options: [{ value: "add", label: "Give the role" }, { value: "remove", label: "Take the role" }] },
    ],
    outputs: [{ key: "count", label: "People changed" }],
    defaults: { channel: "", role: "", mode: "add" },
    summary: "Give {role} to everyone in {channel}",
    builderPerms: () => ["ManageRoles"],
    botPerms: () => ["ManageRoles"],
    grantRoleKeys: ["role"],
    run: async (ctx, config) => {
      const role = resolveRole(ctx, config.role);
      checkRoleManageable(ctx, role);
      const channel = await resolveChannel(ctx, config.channel);
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) throw new StepError("Pick a voice channel.");
      const add = config.mode !== "remove";
      const members = [...channel.members.values()].filter((m) => m.roles.cache.has(role.id) !== add).slice(0, LIMITS.massMembers);
      let count = 0;
      for (const member of members) {
        await discordCall(ctx, () => (add ? member.roles.add(role, `Custom command /${ctx.commandName}`) : member.roles.remove(role, `Custom command /${ctx.commandName}`)));
        count += 1;
      }
      return { outputs: { count } };
    },
  },
];
