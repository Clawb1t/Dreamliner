import type { Client, Guild, GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { embedField } from "../../../core/embeds.js";
import { getLogger } from "../../../core/logger.js";
import { safeAddRole, safeRemoveRole } from "../../../core/roles.js";
import { channelOr, formatMinutes, unix } from "./config.js";
import { dmTeamCard, postTeamMessage, teamCard } from "./messages.js";
import { memberRank, usableStatusRole } from "./ranks.js";
import { scheduleRosterUpdate } from "./roster.js";
import { closeBreak, isOverMax, isTooShort, shiftWorkedSeconds } from "./shiftMath.js";
import {
  activeLeaveByUser,
  countActiveShifts,
  getActiveShift,
  getTeamMember,
  insertShift,
  listAllActiveShifts,
  updateShift,
  type ShiftRow,
} from "./store.js";

const log = getLogger("team_control");
const DUTY_REASON = "Dreamliner Team Control: shift";

export type ShiftResult = { ok: true; shift: ShiftRow; voided?: boolean } | { ok: false; error: string };

export function shiftTypeName(config: TeamControlConfig, typeId: string | null): string | null {
  if (!typeId) return null;
  return config.shifts.types.find((type) => type.id === typeId)?.name ?? typeId;
}

/** Shift types the member's rank may use. */
export function allowedShiftTypes(config: TeamControlConfig, member: GuildMember) {
  const rank = memberRank(member, config.ranks);
  return config.shifts.types.filter((type) => type.rank_ids.length === 0 || (rank && type.rank_ids.includes(rank.id)));
}

async function applyDutyExtras(member: GuildMember, config: TeamControlConfig): Promise<{ prevNickname: string | null; nickApplied: boolean }> {
  const dutyRole = usableStatusRole(member.guild, config.shifts.duty_role_id);
  if (dutyRole) await safeAddRole(member, dutyRole, DUTY_REASON).catch(() => null);
  const prefix = config.shifts.nickname_prefix;
  // Nicknames are best effort: the owner and members above the bot can't be renamed.
  if (prefix && member.manageable && member.guild.members.me?.permissions.has("ManageNicknames")) {
    const current = member.nickname;
    const base = member.displayName;
    if (!base.startsWith(prefix)) {
      const ok = await member.setNickname(`${prefix}${base}`.slice(0, 32), DUTY_REASON).then(() => true).catch(() => false);
      if (ok) return { prevNickname: current, nickApplied: true };
    }
  }
  return { prevNickname: null, nickApplied: false };
}

async function removeDutyExtras(member: GuildMember, config: TeamControlConfig, shift: ShiftRow): Promise<void> {
  const dutyRole = config.shifts.duty_role_id;
  if (dutyRole && member.roles.cache.has(dutyRole)) await safeRemoveRole(member, dutyRole, DUTY_REASON).catch(() => null);
  const prefix = config.shifts.nickname_prefix;
  if (shift.nickApplied && member.manageable && (!prefix || member.displayName.startsWith(prefix))) {
    await member.setNickname(shift.prevNickname, DUTY_REASON).catch(() => null);
  }
}

async function logShift(client: Client, guild: Guild, config: TeamControlConfig, title: string, body: string, fields: ReturnType<typeof embedField>[], tone: "success" | "neutral" | "warning") {
  const channelId = channelOr(config, config.shifts.log_channel_id);
  if (!channelId) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  await postTeamMessage(client, guild, channelId, teamCard(client, guildConfig, title, body, { tone, fields }));
}

/** Clocks a member in. The caller has already checked they may shift. */
export async function startShift(member: GuildMember, config: TeamControlConfig, typeId: string | null): Promise<ShiftResult> {
  const guild = member.guild;
  if (!config.shifts.enabled) return { ok: false, error: "Shifts are turned off on this server." };
  if (getActiveShift(guild.id, member.id)) return { ok: false, error: "You're already on shift. Use `/team shift end` to clock out." };
  const row = getTeamMember(guild.id, member.id);
  if (row?.status === "suspended") return { ok: false, error: "You're suspended, so you can't clock in." };
  if (config.shifts.block_on_loa && activeLeaveByUser(guild.id).get(member.id)?.kind === "loa") {
    return { ok: false, error: "You're on leave of absence. End your leave with `/team leave end` to clock in." };
  }
  if (config.shifts.max_on_duty > 0 && countActiveShifts(guild.id) >= config.shifts.max_on_duty) {
    return { ok: false, error: `The on-duty limit of **${config.shifts.max_on_duty}** is reached. Try again when someone clocks out.` };
  }
  let type: string | null = null;
  if (typeId) {
    const allowed = allowedShiftTypes(config, member);
    const match = allowed.find((t) => t.id === typeId);
    if (!match) {
      return config.shifts.types.some((t) => t.id === typeId)
        ? { ok: false, error: "Your rank can't use that shift type." }
        : { ok: false, error: "That shift type doesn't exist." };
    }
    type = match.id;
  }
  const extras = await applyDutyExtras(member, config);
  const shift = insertShift({
    guildId: guild.id,
    userId: member.id,
    typeId: type,
    startedAt: new Date(),
    status: "active",
    breakSeconds: 0,
    prevNickname: extras.prevNickname,
    nickApplied: extras.nickApplied,
  });
  const typeName = shiftTypeName(config, type);
  await logShift(member.client, guild, config, "Shift started", `<@${member.id}> clocked in${typeName ? ` for **${typeName}**` : ""}.`, [], "success");
  scheduleRosterUpdate(guild.id);
  return { ok: true, shift };
}

/** Starts or ends a break. */
export async function toggleBreak(member: GuildMember, config: TeamControlConfig): Promise<ShiftResult & { onBreak?: boolean }> {
  const shift = getActiveShift(member.guild.id, member.id);
  if (!shift) return { ok: false, error: "You aren't on shift. Clock in with `/team shift start`." };
  if (!config.shifts.allow_breaks) return { ok: false, error: "Breaks are turned off on this server." };
  const now = Date.now();
  const updated = shift.breakStartedAt
    ? updateShift(member.guild.id, shift.id, { breakSeconds: closeBreak(shift, now), breakStartedAt: null })
    : updateShift(member.guild.id, shift.id, { breakStartedAt: new Date(now) });
  scheduleRosterUpdate(member.guild.id);
  return { ok: true, shift: updated!, onBreak: !shift.breakStartedAt };
}

/**
 * Ends a shift record: closes any break, voids it when shorter than `min_minutes`, takes the duty
 * role and nickname prefix back off and logs it. `member` null = they left the server.
 */
export async function endShiftRecord(
  guild: Guild,
  config: TeamControlConfig,
  shift: ShiftRow,
  endedBy: "self" | "admin" | "auto",
  options: { member?: GuildMember | null; note?: string | null; editorId?: string | null; at?: number } = {},
): Promise<{ shift: ShiftRow; voided: boolean }> {
  const at = options.at ?? Date.now();
  const breakSeconds = closeBreak(shift, at);
  const worked = shiftWorkedSeconds({ ...shift, endedAt: new Date(at), breakSeconds, breakStartedAt: null }, at);
  const voided = isTooShort(worked, config.shifts.min_minutes);
  const note = voided ? `Shorter than ${config.shifts.min_minutes} minutes` : (options.note ?? shift.note);
  const updated =
    updateShift(guild.id, shift.id, {
      endedAt: new Date(at),
      breakSeconds,
      breakStartedAt: null,
      status: voided ? "voided" : "ended",
      endedBy,
      editedBy: options.editorId ?? shift.editedBy,
      note,
    }) ?? shift;
  const member = options.member === undefined ? await guild.members.fetch(shift.userId).catch(() => null) : options.member;
  if (member) await removeDutyExtras(member, config, shift).catch(() => null);
  const by = endedBy === "auto" ? " automatically" : endedBy === "admin" ? " by staff management" : "";
  await logShift(
    guild.client,
    guild,
    config,
    voided ? "Shift voided" : "Shift ended",
    voided
      ? `<@${shift.userId}>'s shift was ended${by} and voided: it was shorter than ${config.shifts.min_minutes} minutes.`
      : `<@${shift.userId}> clocked out${by}.`,
    voided
      ? []
      : [
          embedField("Time on shift", formatMinutes(worked / 60), true),
          embedField("Breaks", formatMinutes(breakSeconds / 60), true),
          embedField("Started", `<t:${unix(shift.startedAt)}:t>`, true),
        ],
    voided ? "warning" : "neutral",
  ).catch(() => null);
  scheduleRosterUpdate(guild.id);
  return { shift: updated, voided };
}

export async function endOwnShift(member: GuildMember, config: TeamControlConfig): Promise<ShiftResult> {
  const shift = getActiveShift(member.guild.id, member.id);
  if (!shift) return { ok: false, error: "You aren't on shift." };
  const result = await endShiftRecord(member.guild, config, shift, "self", { member });
  return { ok: true, shift: result.shift, voided: result.voided };
}

/** Ends shifts that ran past `max_hours` and DMs the member. Runs every minute. */
export async function autoEndLongShifts(client: Client, getConfig: (guildId: string) => Promise<TeamControlConfig | null>): Promise<void> {
  const now = Date.now();
  for (const shift of listAllActiveShifts()) {
    const guild = client.guilds.cache.get(shift.guildId);
    if (!guild) continue;
    const config = await getConfig(shift.guildId);
    if (!config || !isOverMax(shift, config.shifts.max_hours, now)) continue;
    const member = await guild.members.fetch(shift.userId).catch(() => null);
    const { voided } = await endShiftRecord(guild, config, shift, "auto", { member, note: `Ended after ${config.shifts.max_hours} hours` });
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    await dmTeamCard(
      member?.user,
      teamCard(
        client,
        guildConfig,
        "Shift ended automatically",
        `Your shift in **${guild.name}** ran past the ${config.shifts.max_hours}-hour limit, so I clocked you out.${voided ? " It was voided." : ""} Clock in again with \`/team shift start\` if you're still working.`,
        { tone: "warning" },
      ),
    ).catch(() => false);
    log.info(`Auto-ended shift ${shift.id} in ${shift.guildId}`);
  }
}
