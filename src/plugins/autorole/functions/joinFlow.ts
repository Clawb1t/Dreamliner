import type { GuildMember } from "discord.js";
import type { AutoroleConfig } from "../../../config/schemas/autorole.js";
import { configManager } from "../../../config/manager.js";
import { getAutorolePluginConfig } from "../../../core/guildHelpers.js";
import { capMap, createPruner } from "../../../core/mapPrune.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import {
  audienceForMember,
  planAutoroleJoin,
  scheduleAutoroles,
  shouldScheduleAfterPassport,
} from "./applyRoles.js";

/**
 * Join-time flow for Autorole's "Works with" options:
 *  - wait_for_passport: hold human autoroles until Passport verification completes
 *    (completePassportVerification calls scheduleAutorolesAfterPassport).
 *  - skip_if_restored: skip autoroles when Member Identity gives saved roles back this join.
 *    Both GuildMemberAdd handlers share one restore through restoreMemberIdentity's per-join memo,
 *    so it doesn't matter which runs first; each autorole waits for the restore (including its
 *    delay_ms) before deciding.
 */

const PROCESS_STARTED_AT = Date.now();
const HELD_MS = 24 * 60 * 60_000;
/** Members whose autoroles were held at join, waiting on Passport. */
const held = new Map<string, number>();
const pruneHeld = createPruner(held, (at, now) => now - at >= HELD_MS, 10 * 60_000);

function joinKey(member: GuildMember): string {
  return `${member.guild.id}:${member.id}:${member.joinedTimestamp ?? 0}`;
}

async function memberPassedPassport(member: GuildMember): Promise<boolean> {
  try {
    const { hasMemberPassedPassport } = await import("../../passport/functions/gate.js");
    return await hasMemberPassedPassport(member);
  } catch {
    // Passport unavailable: never hold roles on it.
    return true;
  }
}

async function restoreOutcome(member: GuildMember, startIfMissing: boolean): Promise<boolean> {
  try {
    const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
    if (!pluginEnabled(guildConfig, "member_identity")) return false;
    const { restoreMemberIdentity, peekMemberRestore } = await import(
      "../../member_identity/functions/handlers.js"
    );
    const running = peekMemberRestore(member);
    if (running) return await running;
    return startIfMissing ? await restoreMemberIdentity(member) : false;
  } catch {
    return false;
  }
}

export async function handleAutoroleJoin(member: GuildMember, config: AutoroleConfig): Promise<void> {
  const audience = audienceForMember(member);
  const passed = config.wait_for_passport === true && audience === "humans" ? await memberPassedPassport(member) : true;
  if (planAutoroleJoin(config, audience, passed) === "wait_for_passport") {
    pruneHeld();
    held.set(joinKey(member), Date.now());
    capMap(held, 20_000);
    return;
  }
  scheduleAutoroles(member, config, {
    skipIfRestored: config.skip_if_restored === true,
    restoreOutcome: config.skip_if_restored === true ? restoreOutcome(member, true) : null,
  });
}

/** Called once a member passes Passport. Gives held autoroles; per-role delays count from now. */
export async function scheduleAutorolesAfterPassport(member: GuildMember): Promise<void> {
  if (!member.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!pluginEnabled(guildConfig, "autorole")) return;
  const config = getAutorolePluginConfig(guildConfig) as AutoroleConfig;

  const key = joinKey(member);
  const heldAtJoin = held.delete(key);
  const schedule = shouldScheduleAfterPassport({
    config,
    audience: audienceForMember(member),
    heldAtJoin,
    joinedAt: member.joinedTimestamp,
    processStartedAt: PROCESS_STARTED_AT,
  });
  if (!schedule) return;

  // Never start a restore this late: only reuse the outcome of the one that ran at join.
  scheduleAutoroles(member, config, {
    skipIfRestored: config.skip_if_restored === true,
    restoreOutcome: config.skip_if_restored === true ? restoreOutcome(member, false) : null,
  });
}
