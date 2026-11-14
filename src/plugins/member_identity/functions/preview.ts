import type { MemberIdentityConfig } from "../../../config/schemas/plugins.js";

/**
 * "What comes back if this member rejoins", worked out from the saved snapshot and the server's
 * current Member Identity settings. Pure (no Discord calls) so the website's identity card and the
 * unit tests share exactly the rules restoreMemberIdentity/applySnapshot in handlers.ts follow.
 */

export type RestoreBlockReason =
  /** The Member Identity plugin is turned off in this server. */
  | "plugin_off"
  /** The matching restore setting (restore_roles / restore_nickname / restore_timeout) is off. */
  | "restore_off"
  /** The member is a bot and the server skips bots (ignore_bots). */
  | "bots_ignored"
  /** The role no longer exists in the server. */
  | "deleted"
  /** The role is on the server's "never restore" list (ignored_roles). */
  | "ignored"
  /** Discord manages the role (boost, bot, or integration role), so nobody can hand it out. */
  | "managed"
  /** The role sits at or above Dreamliner's highest role. */
  | "above_bot"
  /** Dreamliner is missing the Discord permission it needs (Manage Roles / Nicknames, Moderate Members). */
  | "no_permission"
  /** Nothing was saved for this part (no nickname, or no timeout). */
  | "nothing_saved"
  /** The saved timeout has already run out. */
  | "expired"
  /** Discord never lets bots change the server owner's nickname. */
  | "owner";

export type RestoreRoleFacts = {
  id: string;
  /** False when the role was deleted after it was saved. */
  exists: boolean;
  managed: boolean;
  position: number;
};

export type RestorePreviewInput = {
  pluginEnabled: boolean;
  config: Pick<
    MemberIdentityConfig,
    "restore_nickname" | "restore_roles" | "restore_timeout" | "skip_managed_roles" | "ignore_bots" | "ignored_roles"
  >;
  snapshot: { nickname: string; roleIds: string[]; timeoutUntil: number | null };
  /** Facts about each saved role, looked up in the server (missing entries count as deleted). */
  roles: Map<string, RestoreRoleFacts>;
  /** Dreamliner's own standing in the server; null when it can't be resolved. */
  bot: {
    highestPosition: number;
    manageRoles: boolean;
    manageNicknames: boolean;
    moderateMembers: boolean;
  } | null;
  targetIsBot: boolean;
  targetIsOwner: boolean;
  guildId: string;
  now: number;
};

export type RestorePart = { restores: boolean; reason: RestoreBlockReason | null };
export type RestoreRolePreview = RestorePart & { id: string };

export type RestorePreview = {
  /** Anything at all comes back on rejoin. */
  anything: boolean;
  /** Why nothing comes back at all, when the answer is the same for every part. */
  blockedReason: RestoreBlockReason | null;
  nickname: RestorePart;
  timeout: RestorePart;
  roles: RestoreRolePreview[];
};

function wholeBlock(input: RestorePreviewInput): RestoreBlockReason | null {
  if (!input.pluginEnabled) return "plugin_off";
  if (input.config.ignore_bots && input.targetIsBot) return "bots_ignored";
  const { restore_nickname, restore_roles, restore_timeout } = input.config;
  if (!restore_nickname && !restore_roles && !restore_timeout) return "restore_off";
  return null;
}

function roleReason(input: RestorePreviewInput, roleId: string): RestoreBlockReason | null {
  const role = input.roles.get(roleId);
  if (!role || !role.exists) return "deleted";
  if (input.config.ignored_roles.includes(roleId)) return "ignored";
  // Discord never lets anyone hand out a managed role, so it can't come back even with the
  // setting off; the setting only decides whether Dreamliner tries.
  if (role.managed) return "managed";
  if (!input.bot) return "no_permission";
  if (role.position >= input.bot.highestPosition) return "above_bot";
  if (!input.bot.manageRoles) return "no_permission";
  return null;
}

export function previewIdentityRestore(input: RestorePreviewInput): RestorePreview {
  const blocked = wholeBlock(input);
  const roleIds = input.snapshot.roleIds.filter((id) => id !== input.guildId);

  const roles: RestoreRolePreview[] = roleIds.map((id) => {
    const reason = blocked ?? (input.config.restore_roles ? roleReason(input, id) : "restore_off");
    return { id, restores: reason === null, reason };
  });

  let nicknameReason: RestoreBlockReason | null;
  if (blocked) nicknameReason = blocked;
  else if (!input.config.restore_nickname) nicknameReason = "restore_off";
  else if (!input.snapshot.nickname) nicknameReason = "nothing_saved";
  else if (input.targetIsOwner) nicknameReason = "owner";
  else if (!input.bot?.manageNicknames) nicknameReason = "no_permission";
  else nicknameReason = null;

  let timeoutReason: RestoreBlockReason | null;
  if (blocked) timeoutReason = blocked;
  else if (!input.config.restore_timeout) timeoutReason = "restore_off";
  else if (!input.snapshot.timeoutUntil) timeoutReason = "nothing_saved";
  else if (input.snapshot.timeoutUntil <= input.now) timeoutReason = "expired";
  else if (!input.bot?.moderateMembers) timeoutReason = "no_permission";
  else timeoutReason = null;

  const nickname = { restores: nicknameReason === null, reason: nicknameReason };
  const timeout = { restores: timeoutReason === null, reason: timeoutReason };
  return {
    anything: nickname.restores || timeout.restores || roles.some((role) => role.restores),
    blockedReason: blocked,
    nickname,
    timeout,
    roles,
  };
}
