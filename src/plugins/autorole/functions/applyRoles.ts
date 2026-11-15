import type { GuildMember, Role } from "discord.js";
import type {
  AutoroleAudience,
  AutoroleConfig,
  AutoroleRoleEntry,
  NormalizedAutoroleEntry,
} from "../../../config/schemas/autorole.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parseDuration } from "../../infraction/functions/duration.js";
import { isStaffRole } from "../../../core/roles.js";

export function resolveRoleDelayMs(entry: Pick<AutoroleRoleEntry, "delay_ms" | "delay">): number {
  if (entry.delay) {
    const parsed = parseDuration(entry.delay);
    if (parsed !== null) return parsed;
  }
  return entry.delay_ms;
}

export function roleListForAudience(
  config: AutoroleConfig,
  audience: AutoroleAudience,
): AutoroleConfig["roles"] {
  return audience === "bots" ? config.bot_roles : config.roles;
}

export function normalizeAutoroleEntries(
  config: AutoroleConfig,
  audience: AutoroleAudience = "humans",
): NormalizedAutoroleEntry[] {
  return roleListForAudience(config, audience).map((entry) => {
    if (typeof entry === "string") {
      return { roleId: entry, delayMs: 0 };
    }
    return { roleId: entry.role, delayMs: resolveRoleDelayMs(entry) };
  });
}

export function audienceForMember(member: GuildMember): AutoroleAudience {
  return member.user.bot ? "bots" : "humans";
}

export function filterAssignableRoles(member: GuildMember, roleIds: string[]): Role[] {
  const me = member.guild.members.me;
  if (!me) return [];

  const highest = me.roles.highest.position;
  return roleIds
    .map((id) => member.guild.roles.cache.get(id))
    .filter((role): role is Role => {
      if (!role) return false;
      if (member.roles.cache.has(role.id)) return false;
      if (!role.editable) return false;
      if (role.position >= highest) return false;
      return true;
    });
}

export async function applyAutoroles(member: GuildMember, roleIds: string[]): Promise<void> {
  const roles = filterAssignableRoles(member, roleIds).filter((role) => !isStaffRole(role));
  if (roles.length === 0) return;
  await member.roles.add(roles, "Dreamliner autorole").catch(() => null);
}

export type AutoroleJoinPlan = "now" | "wait_for_passport";

/** On join: give autoroles now, or hold them until Passport verification completes. Bots never
 *  verify, so only the humans list waits. */
export function planAutoroleJoin(
  config: Pick<AutoroleConfig, "wait_for_passport">,
  audience: AutoroleAudience,
  passedPassport: boolean,
): AutoroleJoinPlan {
  if (audience === "humans" && config.wait_for_passport === true && !passedPassport) return "wait_for_passport";
  return "now";
}

/** Skip autoroles when `skip_if_restored` is on and Member Identity gave roles back this join. */
export function shouldSkipForRestore(config: Pick<AutoroleConfig, "skip_if_restored">, restoredRoles: boolean): boolean {
  return config.skip_if_restored === true && restoredRoles;
}

/**
 * After Passport: only schedule for members whose autoroles were actually held at join. A member
 * who joined before this process started can't be in the held set (it's in memory), so they're
 * scheduled too rather than missing their roles after a restart.
 */
export function shouldScheduleAfterPassport(input: {
  config: Pick<AutoroleConfig, "wait_for_passport">;
  audience: AutoroleAudience;
  heldAtJoin: boolean;
  joinedAt: number | null;
  processStartedAt: number;
}): boolean {
  if (input.config.wait_for_passport !== true || input.audience !== "humans") return false;
  if (input.heldAtJoin) return true;
  return input.joinedAt !== null && input.joinedAt < input.processStartedAt;
}

type ScheduleOptions = {
  /** Resolves true when Member Identity restored roles this join; checked before each role. */
  restoreOutcome?: Promise<boolean> | null;
  skipIfRestored?: boolean;
};

function scheduleSingleAutorole(
  member: GuildMember,
  roleId: string,
  delayMs: number,
  audience: AutoroleAudience,
  options: ScheduleOptions,
): void {
  // Only the guild and user are kept while waiting (delays can be long); the member is fetched
  // fresh when it's time.
  const guild = member.guild;
  const userId = member.id;
  const run = async () => {
    if (options.restoreOutcome) {
      const restored = await options.restoreOutcome.catch(() => false);
      if (shouldSkipForRestore({ skip_if_restored: options.skipIfRestored ?? false }, restored)) return;
    }
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    if (!pluginEnabled(guildConfig, "autorole")) return;
    const refreshed = await guild.members.fetch(userId).catch(() => null);
    if (!refreshed) return;
    if (audienceForMember(refreshed) !== audience) return;
    await applyAutoroles(refreshed, [roleId]);
  };

  if (delayMs > 0) {
    setTimeout(() => void run(), delayMs);
  } else {
    void run();
  }
}

export function scheduleAutoroles(member: GuildMember, config: AutoroleConfig, options: ScheduleOptions = {}): void {
  const audience = audienceForMember(member);
  const entries = normalizeAutoroleEntries(config, audience);
  for (const entry of entries) {
    scheduleSingleAutorole(member, entry.roleId, entry.delayMs, audience, options);
  }
}
