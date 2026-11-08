/**
 * Server Autopilot plugin setup: points each chosen Dreamliner plugin at the channels and roles
 * the build just made, through the normal config patch helpers. Settings the template doesn't
 * touch are left exactly as the manager configured them.
 */
import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";
import { configManager } from "../../config/manager.js";
import { zAutomodConfig } from "../../config/schemas/automod.js";
import { applyPresetToConfig } from "../../plugins/automod/functions/presets.js";
import { getPluginSettings } from "../permissionRoles.js";
import { parsePluginConfig } from "../pluginSchemas.js";
import { autoGrantableRoleIds } from "../roles.js";
import type { SAPluginSetup, SAPurpose } from "./types.js";

export type PluginTargets = {
  channelId: (key: string | null) => string | null;
  roleId: (key: string | null) => string | null;
  roleIds: (keys: string[]) => string[];
  /** A built channel id by purpose (first match), e.g. the staff chat for suggestion reviews. */
  channelByPurpose: (purposes: SAPurpose[]) => string | null;
  /** Ids of the template's staff-preset roles. */
  staffRoleIds: string[];
};

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

function unwrap(result: { success: true } | { success: false; errors: string[] }): void {
  if (!result.success) throw new Error(result.errors[0] ?? "The config couldn't be saved.");
}

/** Configures one plugin. Returns a one-line summary; throws a readable Error on failure. */
export async function configurePlugin(guild: Guild, setup: SAPluginSetup, targets: PluginTargets, actor: string): Promise<string> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const current = getPluginSettings(guildConfig, setup.plugin === "logs" ? "infractions" : setup.plugin);
  const channel = targets.channelId(setup.channel_key);
  const role = targets.roleId(setup.role_key);
  const extras = targets.roleIds(setup.extra_role_keys);
  const by = `system:server-autopilot:${actor}`;
  const patch = async (values: Record<string, unknown>) => unwrap(await configManager.patchPluginConfig(guild.id, setup.plugin, values, by));
  const enable = async () => unwrap(await configManager.setPluginEnabled(guild.id, setup.plugin, true, by));
  const mention = (id: string | null) => (id ? `<#${id}>` : "");

  switch (setup.plugin) {
    case "welcome_message": {
      if (!channel) throw new Error("No welcome channel was built.");
      await patch({ join: { ...rec(current.join), enabled: true, channel_id: channel } });
      await enable();
      return `Welcome messages post in ${mention(channel)}.`;
    }
    case "logs": {
      const modLogs = channel ?? targets.channelByPurpose(["mod_logs", "logs"]);
      const serverLogs = targets.channelByPurpose(["logs"]) ?? modLogs;
      if (!modLogs) throw new Error("No log channel was built.");
      unwrap(await configManager.patchTopLevelConfig(guild.id, { moderation_log_channel_id: modLogs, server_log_channel_id: serverLogs }, by));
      return serverLogs !== modLogs ? `Moderation logs go to ${mention(modLogs)}, server logs to ${mention(serverLogs)}.` : `Logs go to ${mention(modLogs)}.`;
    }
    case "tickets": {
      const staff = [...new Set([...strings(current.staff_role_ids), ...(role ? [role] : []), ...extras, ...(role || extras.length ? [] : targets.staffRoleIds)])];
      const values: Record<string, unknown> = { staff_role_ids: staff };
      const logChannel = targets.channelByPurpose(["mod_logs", "logs"]);
      if (logChannel && !current.log_channel_id) values.log_channel_id = logChannel;
      await patch(values);
      await enable();
      return "Tickets are on with your support roles. Post a ticket panel from the Tickets page to let members open tickets.";
    }
    case "role_panels":
      return "Self roles are posted as role picker buttons in the starter messages.";
    case "automod": {
      const parsed = parsePluginConfig(zAutomodConfig, current);
      const next = applyPresetToConfig(parsed, setup.level);
      const values: Record<string, unknown> = {
        presets_applied: next.presets_applied,
        rules: next.rules,
        ignored_roles: [...new Set([...parsed.ignored_roles, ...targets.staffRoleIds])],
      };
      if (channel) values.log_channel_id = channel;
      await patch(values);
      await enable();
      return `Automod is on with the ${setup.level} preset${channel ? `, logging to ${mention(channel)}` : ""}.`;
    }
    case "starboard": {
      if (!channel) throw new Error("No starboard channel was built.");
      const boards = Array.isArray(current.boards) ? (current.boards as Array<Record<string, unknown>>) : [];
      if (!boards.some((b) => b.channel_id === channel)) await patch({ boards: [...boards, { channel_id: channel }] });
      await enable();
      return `Starboard posts starred messages in ${mention(channel)}.`;
    }
    case "counting": {
      if (!channel) throw new Error("No counting channel was built.");
      const channels = Array.isArray(current.channels) ? (current.channels as Array<Record<string, unknown>>) : [];
      if (!channels.some((c) => c.channel_id === channel)) await patch({ channels: [...channels, { id: randomUUID(), name: "Counting", channel_id: channel }] });
      await enable();
      return `Counting runs in ${mention(channel)}.`;
    }
    case "suggestions": {
      if (!channel) throw new Error("No suggestions channel was built.");
      const review = targets.channelByPurpose(["staff_chat"]);
      await patch(review ? { suggestions_channel_id: channel, review_channel_id: review, mode: "review" } : { suggestions_channel_id: channel, mode: "autoapprove" });
      await enable();
      return review ? `Suggestions post in ${mention(channel)} after staff review in ${mention(review)}.` : `Suggestions post straight to ${mention(channel)}.`;
    }
    case "autorole": {
      const grantable = role ? autoGrantableRoleIds(guild, [role]) : [];
      if (!grantable.length) throw new Error("The autorole has staff permissions or sits above Dreamliner, so it can't be given automatically.");
      const roles = Array.isArray(current.roles) ? (current.roles as Array<Record<string, unknown>>) : [];
      if (!roles.some((r) => r.role === grantable[0])) await patch({ roles: [...roles, { role: grantable[0] }] });
      await enable();
      return `New members get <@&${grantable[0]}>.`;
    }
    case "passport": {
      if (!channel) throw new Error("No verify channel was built.");
      const grant = role ? autoGrantableRoleIds(guild, [role]) : [];
      await patch({ channel_id: channel, grant_role_ids: [...new Set([...strings(current.grant_role_ids), ...grant])] });
      await enable();
      return `Passport verification runs in ${mention(channel)}${grant.length ? ` and grants <@&${grant[0]}>` : ""}.`;
    }
    case "birthdays": {
      if (!channel) throw new Error("No birthday channel was built.");
      const values: Record<string, unknown> = { announcement: { ...rec(current.announcement), enabled: true, channel_id: channel } };
      const grant = role ? autoGrantableRoleIds(guild, [role]) : [];
      if (grant.length) values.role = { ...rec(current.role), enabled: true, role_id: grant[0] };
      await patch(values);
      await enable();
      return `Birthdays are announced in ${mention(channel)}.`;
    }
    case "giveaways": {
      const values: Record<string, unknown> = {};
      if (role) values.ping_role_id = role;
      const logChannel = targets.channelByPurpose(["mod_logs", "logs"]);
      if (logChannel && !current.log_channel_id) values.log_channel_id = logChannel;
      if (Object.keys(values).length) await patch(values);
      await enable();
      return `Giveaways are on${channel ? `; run them in ${mention(channel)}` : ""}.`;
    }
    case "activity_rewards": {
      if (channel) await patch({ announcement: { ...rec(current.announcement), channel_id: channel } });
      await enable();
      return `Activity Rewards are on${channel ? ` and announce in ${mention(channel)}` : ""}. Add milestones on the Activity Rewards page.`;
    }
    case "invite_tracker": {
      if (channel) await patch({ log_channel_id: channel });
      await enable();
      return `Invite tracking is on${channel ? `, logging joins in ${mention(channel)}` : ""}.`;
    }
  }
  return "";
}
