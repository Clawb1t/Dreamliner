import { PermissionFlagsBits, type Client, type Guild, type Role } from "discord.js";
import { configManager } from "../config/manager.js";
import { renderTemplate } from "../core/templates.js";
import { getPassportConfig, isPassportEnabled } from "../plugins/passport/functions/loadConfig.js";
import { completePassportVerification } from "../plugins/passport/functions/complete.js";
import {
  postPassportPanel,
  resolvePassportChannel,
  sendPassportTestPing,
} from "../plugins/passport/functions/delivery.js";
import {
  deletePassportPending,
  deletePassportVerification,
  getPassportVerification,
} from "../plugins/passport/functions/store.js";
import { isDashboardSuperuser } from "./superuser.js";
import type { PassportPageConfig } from "../config/schemas/passport.js";

function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}

export type PassportPagePayload = {
  ok: true;
  enabled: boolean;
  guild: {
    id: string;
    name: string;
    icon: string | null;
    banner: string | null;
    memberCount: number;
  };
  theme: { accentColor: string };
  background: { type: "none" | "color" | "url" | "guild_banner"; color: string; url: string };
  page: {
    headline: string;
    body: string;
    rules: string;
    loginButtonLabel: string;
    verifyButtonLabel: string;
    showServerIcon: boolean;
    showServerName: boolean;
    showMemberCount: boolean;
    showUserAvatar: boolean;
    successTitle: string;
    successBody: string;
    alreadyVerifiedTitle: string;
    alreadyVerifiedBody: string;
    notAMemberTitle: string;
    notAMemberBody: string;
    disabledTitle: string;
    disabledBody: string;
  };
  viewer: {
    isMember: boolean;
    alreadyVerified: boolean;
    canPractice: boolean;
    rewards: PassportRewardView | null;
  } | null;
};

/** What a member walks away with, shown on the success screen. */
export type PassportRewardView = {
  roles: { id: string; name: string; color: string | null }[];
  nickname: string | null;
};

function renderPageCopy(page: PassportPageConfig, guild: Guild): PassportPagePayload["page"] {
  const ctx = { guild, user: null, member: null };
  const t = (value: string) => renderTemplate(value, ctx).trim();
  return {
    headline: t(page.headline),
    body: t(page.body),
    rules: t(page.rules),
    loginButtonLabel: page.login_button_label,
    verifyButtonLabel: page.verify_button_label,
    showServerIcon: page.show_server_icon,
    showServerName: page.show_server_name,
    showMemberCount: page.show_member_count,
    showUserAvatar: page.show_user_avatar,
    successTitle: t(page.success_title),
    successBody: t(page.success_body),
    alreadyVerifiedTitle: t(page.already_verified_title),
    alreadyVerifiedBody: t(page.already_verified_body),
    notAMemberTitle: t(page.not_a_member_title),
    notAMemberBody: t(page.not_a_member_body),
    disabledTitle: t(page.disabled_title),
    disabledBody: t(page.disabled_body),
  };
}

/** Public page payload for the website /passport/[guildId] route. */
export async function buildPassportPagePayload(
  guild: Guild,
  viewerUserId?: string | null,
): Promise<PassportPagePayload> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const enabled = isPassportEnabled(guildConfig);
  const config = getPassportConfig(guildConfig);
  const page = config.page;

  const accentColor = colorIntToHex(
    page.inherit_accent ? guildConfig.server_accent_color : page.accent_color ?? 0x5662f5,
  );

  let viewer: PassportPagePayload["viewer"] = null;
  const trimmedViewer = viewerUserId?.trim();
  if (trimmedViewer) {
    const member = await guild.members.fetch(trimmedViewer).catch(() => null);
    const alreadyVerified = Boolean(await getPassportVerification(guild.id, trimmedViewer));
    const canPractice =
      isDashboardSuperuser(trimmedViewer) ||
      guild.ownerId === trimmedViewer ||
      Boolean(
        member?.permissions.has(PermissionFlagsBits.Administrator) ||
          member?.permissions.has(PermissionFlagsBits.ManageGuild),
      );
    viewer = {
      isMember: Boolean(member),
      alreadyVerified,
      canPractice,
      rewards:
        member && alreadyVerified
          ? {
              roles: config.grant_role_ids
                .map((id) => member.roles.cache.get(id))
                .filter((role): role is Role => Boolean(role))
                .map((role) => ({
                  id: role.id,
                  name: role.name,
                  color: role.color === 0 ? null : `#${role.color.toString(16).padStart(6, "0")}`,
                })),
              nickname: member.nickname,
            }
          : null,
    };
  }

  return {
    ok: true,
    enabled,
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      banner: guild.banner,
      memberCount: guild.memberCount,
    },
    theme: { accentColor },
    background: {
      type: page.background,
      color: colorIntToHex(page.background_color ?? 0xf4f5f7),
      url: page.background_url,
    },
    page: renderPageCopy(page, guild),
    viewer,
  };
}

export type PassportVerifyResult =
  | { ok: true; alreadyVerified: boolean; rewards: PassportRewardView }
  | { ok: false; code: string; error: string };

/**
 * Complete a verification requested from the website. The website has already
 * checked the Auth.js session and the captcha; here we only trust that the
 * userId is a real Discord member of this guild.
 */
export async function completeWebPassportVerification(
  client: Client,
  guild: Guild,
  userId: string,
): Promise<PassportVerifyResult> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!isPassportEnabled(guildConfig)) {
    return { ok: false, code: "disabled", error: "Verification is off for this server." };
  }

  const config = getPassportConfig(guildConfig);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    return { ok: false, code: "not_a_member", error: "You are not a member of this server." };
  }

  const alreadyVerified = Boolean(await getPassportVerification(guild.id, userId));
  const result = await completePassportVerification({
    client,
    member,
    guildConfig,
    config,
    method: "web",
    alreadyVerified,
  });

  if (!result.ok) return result;
  return {
    ok: true,
    alreadyVerified,
    rewards: { roles: result.rewards.roles, nickname: result.rewards.nickname },
  };
}

/** Dashboard Launch step: post the persistent Verify panel to the configured channel. */
export async function postWebPassportPanel(
  guild: Guild,
  actorUserId: string,
): Promise<{ ok: boolean; detail: string }> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = getPassportConfig(guildConfig);
  const actor = await guild.members.fetch(actorUserId).catch(() => null);
  const result = await postPassportPanel(guild, config, actor);
  return { ok: result.ok, detail: result.detail };
}

/** Dashboard Launch step: send a test ping to the manager who clicked the button. */
export async function sendWebPassportTestPing(
  guild: Guild,
  actorUserId: string,
): Promise<{ ok: boolean; detail: string }> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = getPassportConfig(guildConfig);
  const actor = await guild.members.fetch(actorUserId).catch(() => null);
  if (!actor) {
    return { ok: false, detail: "Could not find you in this server." };
  }
  return sendPassportTestPing(actor, config);
}

/**
 * Clear the manager's own verification so they can walk the live page again.
 * Does not change Discord roles, so staff keep their access.
 */
export async function resetWebPassportPractice(
  guild: Guild,
  actorUserId: string,
): Promise<{ ok: boolean; detail: string }> {
  const actor = await guild.members.fetch(actorUserId).catch(() => null);
  if (!actor && !isDashboardSuperuser(actorUserId)) {
    return { ok: false, detail: "Could not find you in this server." };
  }

  const wasVerified = Boolean(await getPassportVerification(guild.id, actorUserId));
  await deletePassportVerification(guild.id, actorUserId);
  await deletePassportPending(guild.id, actorUserId);

  return {
    ok: true,
    detail: wasVerified
      ? "Your verification was cleared. Walk the page from the start."
      : "You're ready to walk the page from the start.",
  };
}

export type PassportCheckStatus = "ok" | "warn" | "fail";

export type PassportCheck = {
  id: string;
  label: string;
  status: PassportCheckStatus;
  detail: string;
};

export type PassportDiagnostics = {
  ok: boolean;
  summary: { ok: number; warn: number; fail: number };
  checks: PassportCheck[];
};

function checkRole(
  guild: Guild,
  botTopPosition: number,
  roleId: string,
): { role: Role | null; status: PassportCheckStatus; detail: string } {
  const role = guild.roles.cache.get(roleId) ?? null;
  if (!role) {
    return { role: null, status: "fail", detail: "This role no longer exists in the server." };
  }
  if (role.managed) {
    return {
      role,
      status: "fail",
      detail: `**${role.name}** is managed by an integration, so it can't be added or removed.`,
    };
  }
  if (role.position >= botTopPosition) {
    return {
      role,
      status: "fail",
      detail: `**${role.name}** sits above Dreamliner in the role list. Drag Dreamliner's role higher in Server Settings → Roles.`,
    };
  }
  return { role, status: "ok", detail: `**${role.name}** is below Dreamliner, so it can be assigned.` };
}

/**
 * Dashboard Test step: run every check a real join would depend on, so the
 * manager finds broken permissions here instead of on their next new member.
 */
export async function runPassportDiagnostics(guild: Guild): Promise<PassportDiagnostics> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const enabled = isPassportEnabled(guildConfig);
  const config = getPassportConfig(guildConfig);
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const botTopPosition = me?.roles.highest.position ?? 0;
  const checks: PassportCheck[] = [];

  checks.push({
    id: "enabled",
    label: "Passport is switched on",
    status: enabled ? "ok" : "fail",
    detail: enabled
      ? "New members will be gated as soon as they join."
      : "Passport is off, so nothing runs yet. Turn it on at the top of this page.",
  });

  const canManageRoles = me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false;
  checks.push({
    id: "manage_roles",
    label: "Dreamliner can manage roles",
    status: canManageRoles ? "ok" : "fail",
    detail: canManageRoles
      ? "Dreamliner has the Manage Roles permission."
      : "Give Dreamliner the Manage Roles permission, or it can't gate or unlock anyone.",
  });

  const channelId = config.channel_id?.trim() ?? "";
  const channel = channelId ? await resolvePassportChannel(guild, channelId) : null;
  if (!channelId) {
    checks.push({
      id: "channel",
      label: "Verify channel is set",
      status: "fail",
      detail: "Pick the channel where new members get pinged, on the Protect step.",
    });
  } else if (!channel) {
    checks.push({
      id: "channel",
      label: "Verify channel is set",
      status: "fail",
      detail: "That channel was deleted or isn't a text channel any more. Pick a new one.",
    });
  } else {
    const perms = me ? channel.permissionsFor(me) : null;
    const canView = perms?.has(PermissionFlagsBits.ViewChannel) ?? false;
    const canSend = perms?.has(PermissionFlagsBits.SendMessages) ?? false;
    const canEmbed = perms?.has(PermissionFlagsBits.EmbedLinks) ?? false;
    const missing = [
      !canView ? "View Channel" : null,
      !canSend ? "Send Messages" : null,
      !canEmbed ? "Embed Links" : null,
    ].filter(Boolean);
    checks.push({
      id: "channel",
      label: "Dreamliner can post in the verify channel",
      status: missing.length === 0 ? "ok" : "fail",
      detail:
        missing.length === 0
          ? `Join pings will land in **#${channel.name}**.`
          : `Dreamliner is missing ${missing.join(", ")} in **#${channel.name}**.`,
    });
  }

  const unverifiedId = config.unverified_role_id?.trim() ?? "";
  let unverifiedRole: Role | null = null;
  if (!unverifiedId) {
    checks.push({
      id: "unverified_role",
      label: "Unverified role is set",
      status: "warn",
      detail:
        "No holding role is set. New members will keep whatever access @everyone has until they verify.",
    });
  } else {
    const result = checkRole(guild, botTopPosition, unverifiedId);
    unverifiedRole = result.role;
    checks.push({
      id: "unverified_role",
      label: "Unverified role can be applied",
      status: result.status,
      detail: result.detail,
    });
  }

  const grantIds = config.grant_role_ids.filter((id) => id.trim().length > 0);
  if (grantIds.length === 0) {
    checks.push({
      id: "grant_roles",
      label: "Reward roles are set",
      status: "warn",
      detail:
        "No roles are granted on success. That's fine if the unverified role alone controls access.",
    });
  } else {
    const results = grantIds.map((id) => checkRole(guild, botTopPosition, id));
    const broken = results.filter((r) => r.status !== "ok");
    checks.push({
      id: "grant_roles",
      label: "Reward roles can be granted",
      status: broken.length === 0 ? "ok" : "fail",
      detail:
        broken.length === 0
          ? `${results.length} role${results.length === 1 ? "" : "s"} ready to hand out on success.`
          : broken.map((r) => r.detail).join(" "),
    });
  }

  if (unverifiedRole && channel) {
    const canSeeVerifyChannel =
      channel.permissionsFor(unverifiedRole)?.has(PermissionFlagsBits.ViewChannel) ?? false;
    const otherVisible = guild.channels.cache.filter((ch) => {
      if (ch.id === channel.id) return false;
      if (!("permissionsFor" in ch) || typeof ch.permissionsFor !== "function") return false;
      return ch.permissionsFor(unverifiedRole)?.has(PermissionFlagsBits.ViewChannel) ?? false;
    }).size;

    if (!canSeeVerifyChannel) {
      checks.push({
        id: "gate",
        label: "Unverified members can reach the verify channel",
        status: "fail",
        detail: `**${unverifiedRole.name}** can't see **#${channel.name}**, so new members will land in an empty server with no way to verify.`,
      });
    } else if (otherVisible > 0) {
      checks.push({
        id: "gate",
        label: "The gate actually holds people back",
        status: "warn",
        detail: `**${unverifiedRole.name}** can still see ${otherVisible} other channel${otherVisible === 1 ? "" : "s"}. Deny View Channel for that role everywhere except **#${channel.name}**.`,
      });
    } else {
      checks.push({
        id: "gate",
        label: "The gate actually holds people back",
        status: "ok",
        detail: `**${unverifiedRole.name}** can only see **#${channel.name}** until they verify.`,
      });
    }
  }

  if (config.timeout_action === "kick" && config.timeout_seconds > 0) {
    const canKick = me?.permissions.has(PermissionFlagsBits.KickMembers) ?? false;
    checks.push({
      id: "kick",
      label: "Dreamliner can kick on timeout",
      status: canKick ? "ok" : "fail",
      detail: canKick
        ? "Members who never verify in time will be removed."
        : "Give Dreamliner the Kick Members permission, or the timeout action will silently do nothing.",
    });
  }

  if (config.nickname.trim().length > 0) {
    const canNick = me?.permissions.has(PermissionFlagsBits.ManageNicknames) ?? false;
    checks.push({
      id: "nickname",
      label: "Dreamliner can set nicknames",
      status: canNick ? "ok" : "warn",
      detail: canNick
        ? "Verified members will be renamed with your template."
        : "Dreamliner is missing Manage Nicknames, so the nickname template will be skipped.",
    });
  }

  const summary = {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };

  return { ok: summary.fail === 0, summary, checks };
}
