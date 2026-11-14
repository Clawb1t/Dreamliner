import type { Guild, GuildMember } from "discord.js";
import { configManager } from "../config/manager.js";
import type { TeamControlConfig } from "../config/schemas/teamControl.js";
import { decodeBase64Upload, readPageAsset, savePageAsset } from "../core/pageAssets.js";
import { isTeamControlEnabled, loadTeamControlConfig, formatMinutes, type TeamStatus } from "../plugins/team_control/functions/config.js";
import {
  colorIntToHex,
  isKioskAction,
  kioskAvailability,
  kioskBreaksAllowed,
  kioskQuotaItems,
  localDayRange,
  planKioskAction,
  renderKioskText,
  resolveKioskShiftType,
  secondsInRange,
  type KioskAvailability,
  type KioskQuotaItem,
} from "../plugins/team_control/functions/kiosk.js";
import { applyOneGate, historyCutoff, isTeamOneActive } from "../plugins/team_control/functions/oneGate.js";
import { periodRange, toTeamPeriod, type TeamPeriod } from "../plugins/team_control/functions/periods.js";
import { memberRank } from "../plugins/team_control/functions/ranks.js";
import { shiftWorkedSeconds, totalBreakSeconds } from "../plugins/team_control/functions/shiftMath.js";
import { allowedShiftTypes, endOwnShift, maySelfShift, shiftTypeName, startShift, toggleBreak } from "../plugins/team_control/functions/shifts.js";
import {
  activeLeaveByUser,
  countActiveShifts,
  getActiveShift,
  getOpenLeave,
  getTeamMember,
  listShifts,
  shiftsOverlapping,
  type ShiftRow,
} from "../plugins/team_control/functions/store.js";
import { summarizeMember } from "../plugins/team_control/functions/team.js";
import { SlidingWindowLimiter } from "./rateLimit.js";

// Response shapes are the bot ⇄ website contract for the kiosk page (/kiosk/[guildId]); keep them
// in step with the website's src/lib/botBridge.ts (TeamKiosk* types).

export class KioskBridgeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
  ) {
    super(message);
  }
}

export type KioskPagePayload = {
  ok: true;
  availability: KioskAvailability;
  guild: { id: string; name: string; icon: string | null; banner: string | null };
  theme: { accentColor: string };
  background: { type: TeamControlConfig["kiosk"]["background"]; color: string; url: string };
  page: {
    /** {guild} already filled in; {user} is left for the website to fill with the viewer's name. */
    title: string;
    welcome: string;
    clockInLabel: string;
    clockOutLabel: string;
    layout: TeamControlConfig["kiosk"]["layout"];
    clockFormat: TeamControlConfig["kiosk"]["clock_format"];
    showServerIcon: boolean;
    showServerName: boolean;
    showWallClock: boolean;
    showRank: boolean;
    showOnDuty: boolean;
    showToday: boolean;
    showPeriod: boolean;
    showQuota: boolean;
    showRecent: boolean;
  };
};

export type KioskShift = {
  id: number;
  typeId: string | null;
  typeName: string | null;
  startedAt: string;
  endedAt: string | null;
  workedSeconds: number;
  breakSeconds: number;
  status: "active" | "ended" | "voided";
  endedBy: "self" | "admin" | "auto" | null;
};

export type KioskStatePayload = {
  ok: true;
  /** For correcting the browser's clock when it runs fast or slow. */
  serverNow: string;
  viewer: { userId: string; name: string; avatarUrl: string | null; rankName: string | null; rankColor: string | null };
  status: TeamStatus;
  shift: {
    id: number;
    typeId: string | null;
    typeName: string | null;
    startedAt: string;
    /** Finished breaks only; a running break is `breakStartedAt` to now. */
    breakSeconds: number;
    breakStartedAt: string | null;
    workedSeconds: number;
  } | null;
  shiftTypes: Array<{ id: string; name: string }>;
  rules: { breaksAllowed: boolean; requireType: boolean; minMinutes: number; maxHours: number; confirmClockOut: boolean };
  /** A heads-up for why clocking in would be refused right now (the shift functions still decide). */
  clockInBlocked: string | null;
  onDuty: { count: number; limit: number };
  leave: { kind: "loa" | "ra"; status: string; startsAt: string; endsAt: string } | null;
  totals: { todaySeconds: number; periodSeconds: number; live: boolean; period: TeamPeriod };
  quota: { met: boolean; excused: boolean; progress: number; items: KioskQuotaItem[] } | null;
  recent: KioskShift[];
};

export type KioskActionPayload = { ok: true; message: string; tone: "success" | "warning"; state: KioskStatePayload };

const RECENT_SHIFTS = 5;

/** Kiosk presses per member per server: far above anyone actually clocking in and out. */
const actionLimiter = new SlidingWindowLimiter(20, 60_000);
/** One press at a time per member, so a double tap can't clock someone in twice while roles are being given. */
const inFlight = new Set<string>();

async function loadKioskRuntime(guild: Guild) {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const one = await isTeamOneActive(guild.id);
  const enabled = isTeamControlEnabled(guildConfig);
  const config = applyOneGate(loadTeamControlConfig(guildConfig), one);
  return { guildConfig, one, enabled, config, availability: kioskAvailability(enabled, config) };
}
type KioskRuntime = Awaited<ReturnType<typeof loadKioskRuntime>>;

/** The kiosk's look: public (like the Passport page), so the sign-in screen can be branded. */
export async function buildKioskPage(guild: Guild): Promise<KioskPagePayload> {
  const runtime = await loadKioskRuntime(guild);
  const kiosk = runtime.config.kiosk;
  let backgroundUrl = kiosk.background === "url" ? kiosk.background_url : "";
  if (kiosk.background === "asset" && kiosk.background_asset_id) {
    const buf = readPageAsset(guild.id, "team_kiosk", kiosk.background_asset_id);
    backgroundUrl = buf ? `data:image/png;base64,${buf.toString("base64")}` : "";
  }
  return {
    ok: true,
    availability: runtime.availability,
    guild: { id: guild.id, name: guild.name, icon: guild.icon, banner: guild.banner },
    theme: { accentColor: colorIntToHex(kiosk.inherit_accent ? runtime.guildConfig.server_accent_color : kiosk.accent_color) },
    background: { type: kiosk.background, color: colorIntToHex(kiosk.background_color), url: backgroundUrl },
    page: {
      title: renderKioskText(kiosk.title, { guild: guild.name, user: "{user}" }),
      welcome: renderKioskText(kiosk.welcome, { guild: guild.name, user: "{user}" }),
      clockInLabel: kiosk.clock_in_label,
      clockOutLabel: kiosk.clock_out_label,
      layout: kiosk.layout,
      clockFormat: kiosk.clock_format,
      showServerIcon: kiosk.show_server_icon,
      showServerName: kiosk.show_server_name,
      showWallClock: kiosk.show_wall_clock,
      showRank: kiosk.show_rank,
      showOnDuty: kiosk.show_on_duty,
      showToday: kiosk.show_today,
      showPeriod: kiosk.show_period,
      showQuota: kiosk.show_quota,
      showRecent: kiosk.show_recent,
    },
  };
}

function requireAvailable(runtime: KioskRuntime): void {
  switch (runtime.availability) {
    case "plugin_off":
      throw new KioskBridgeError("Team Control is turned off on this server.", 409, "plugin_off");
    case "kiosk_off":
      throw new KioskBridgeError("The clock-in kiosk is turned off on this server.", 409, "kiosk_off");
    case "shifts_off":
      throw new KioskBridgeError("Shifts are turned off on this server.", 409, "shifts_off");
    default:
  }
}

/**
 * The viewer as a staff member of this server. They must be in the server right now and able to
 * shift exactly as on Discord (a rank role, or `can_shift`); suspended staff can still look.
 * Everyone else gets a 403 with no data.
 */
async function resolveStaff(guild: Guild, runtime: KioskRuntime, userId: string): Promise<GuildMember> {
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  if (!member) throw new KioskBridgeError("You need to be in this server to use its clock-in kiosk.", 403, "not_member");
  if (member.user.bot) throw new KioskBridgeError("Only staff can use this kiosk.", 403, "not_staff");
  const row = getTeamMember(guild.id, userId);
  const suspended = row?.status === "suspended" && row.leftTeamAt === null;
  if (!suspended && !(await maySelfShift(member, runtime.guildConfig, runtime.config))) {
    throw new KioskBridgeError("Only staff on this server's team can use this kiosk.", 403, "not_staff");
  }
  return member;
}

function roleColor(guild: Guild, roleId: string | null): string | null {
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  return role && role.color !== 0 ? colorIntToHex(role.color) : null;
}

function kioskShift(config: TeamControlConfig, shift: ShiftRow, now: number): KioskShift {
  return {
    id: shift.id,
    typeId: shift.typeId,
    typeName: shiftTypeName(config, shift.typeId),
    startedAt: shift.startedAt.toISOString(),
    endedAt: shift.endedAt?.toISOString() ?? null,
    workedSeconds: shiftWorkedSeconds(shift, now),
    breakSeconds: totalBreakSeconds(shift, now),
    status: shift.status as KioskShift["status"],
    endedBy: (shift.endedBy as KioskShift["endedBy"]) ?? null,
  };
}

function buildState(guild: Guild, runtime: KioskRuntime, member: GuildMember, tzOffset: number, now = Date.now()): KioskStatePayload {
  const { config, one } = runtime;
  const userId = member.id;
  const row = getTeamMember(guild.id, userId);
  const shift = getActiveShift(guild.id, userId);
  const leaveNow = activeLeaveByUser(guild.id).get(userId) ?? null;
  const openLeave = getOpenLeave(guild.id, userId);
  const suspended = row?.status === "suspended";

  // Same order as the roster's statuses: suspension, then the shift, then leave.
  const status: TeamStatus = suspended
    ? "suspended"
    : shift
      ? shift.breakStartedAt
        ? "on_break"
        : "on_duty"
      : leaveNow
        ? leaveNow.kind === "ra"
          ? "ra"
          : "loa"
        : "off_duty";

  const rank = memberRank(member, config.ranks) ?? (suspended ? (config.ranks.find((r) => r.id === row?.rankId) ?? null) : null);
  const onDutyCount = countActiveShifts(guild.id);

  let clockInBlocked: string | null = null;
  if (!shift) {
    if (suspended) clockInBlocked = "You're suspended, so you can't clock in.";
    else if (config.shifts.block_on_loa && leaveNow?.kind === "loa") clockInBlocked = "You're on leave of absence. End your leave to clock in.";
    else if (config.shifts.max_on_duty > 0 && onDutyCount >= config.shifts.max_on_duty) {
      clockInBlocked = `The on-duty limit of ${config.shifts.max_on_duty} is reached. Try again when someone clocks out.`;
    }
  }

  const day = localDayRange(now, tzOffset);
  const range = periodRange(config.activity.period, config.activity.week_start, "current", now);
  const todaySeconds = secondsInRange(shiftsOverlapping(guild.id, new Date(day.start), new Date(day.end), [userId]), day.start, day.end, now);
  const periodSeconds = secondsInRange(
    shiftsOverlapping(guild.id, range.start, range.end, [userId]),
    range.start.getTime(),
    range.end.getTime(),
    now,
  );

  let quota: KioskStatePayload["quota"] = null;
  if (config.activity.enabled && row && row.leftTeamAt === null) {
    const summary = summarizeMember(guild.id, config, range, one, userId);
    if (summary) {
      quota = {
        met: summary.quota.met,
        excused: summary.quota.excused,
        progress: summary.quota.progress,
        items: kioskQuotaItems(summary.quota, summary.metrics),
      };
    }
  }

  const recent = listShifts(guild.id, { userId, since: historyCutoff(one, now) }, RECENT_SHIFTS + 1, 0)
    .rows.filter((s) => s.status !== "active")
    .slice(0, RECENT_SHIFTS)
    .map((s) => kioskShift(config, s, now));

  return {
    ok: true,
    serverNow: new Date(now).toISOString(),
    viewer: {
      userId,
      name: member.displayName,
      avatarUrl: member.displayAvatarURL({ size: 128, extension: "png" }),
      rankName: rank?.name ?? null,
      rankColor: roleColor(guild, rank?.role_id ?? null),
    },
    status,
    shift: shift
      ? {
          id: shift.id,
          typeId: shift.typeId,
          typeName: shiftTypeName(config, shift.typeId),
          startedAt: shift.startedAt.toISOString(),
          breakSeconds: shift.breakSeconds,
          breakStartedAt: shift.breakStartedAt?.toISOString() ?? null,
          workedSeconds: shiftWorkedSeconds(shift, now),
        }
      : null,
    shiftTypes: allowedShiftTypes(config, member).map((type) => ({ id: type.id, name: type.name })),
    rules: {
      breaksAllowed: kioskBreaksAllowed(config),
      requireType: config.kiosk.require_type,
      minMinutes: config.shifts.min_minutes,
      maxHours: config.shifts.max_hours,
      confirmClockOut: config.kiosk.confirm_clock_out,
    },
    clockInBlocked,
    onDuty: { count: onDutyCount, limit: config.shifts.max_on_duty },
    leave: openLeave
      ? {
          kind: openLeave.kind as "loa" | "ra",
          status: openLeave.status,
          startsAt: openLeave.startsAt.toISOString(),
          endsAt: openLeave.endsAt.toISOString(),
        }
      : null,
    totals: { todaySeconds, periodSeconds, live: Boolean(shift && !shift.breakStartedAt), period: toTeamPeriod(range) },
    quota,
    recent,
  };
}

/** The signed-in viewer's shift state on this server's kiosk. */
export async function getKioskState(guild: Guild, userId: string, tzOffset: number): Promise<KioskStatePayload> {
  const runtime = await loadKioskRuntime(guild);
  requireAvailable(runtime);
  const member = await resolveStaff(guild, runtime, userId);
  return buildState(guild, runtime, member, tzOffset);
}

/**
 * A kiosk button press. Runs the same shift functions as /team shift and the roster board, so
 * every rule, log line, duty role and nickname prefix behaves exactly as it does on Discord.
 */
export async function runKioskAction(guild: Guild, userId: string, body: Record<string, unknown>, tzOffset: number): Promise<KioskActionPayload> {
  const action = body.action;
  if (!isKioskAction(action)) throw new KioskBridgeError("Unknown kiosk action.", 400, "bad_action");
  const rawType = body.typeId;
  if (rawType != null && (typeof rawType !== "string" || !/^[a-z0-9_-]{1,32}$/.test(rawType))) {
    throw new KioskBridgeError("That shift type doesn't exist.", 400, "bad_type");
  }
  const key = `${guild.id}:${userId}`;
  const limit = actionLimiter.take(key);
  if (!limit.ok) {
    throw new KioskBridgeError(`You're doing that too fast. Try again in ${Math.ceil(limit.retryAfterMs / 1000)}s.`, 429, "rate_limited");
  }
  if (inFlight.has(key)) throw new KioskBridgeError("Hold on, your last action is still going through.", 409, "busy");
  inFlight.add(key);
  try {
    const runtime = await loadKioskRuntime(guild);
    requireAvailable(runtime);
    const member = await resolveStaff(guild, runtime, userId);
    const { config } = runtime;
    const plan = planKioskAction(action, getActiveShift(guild.id, userId), { breaksAllowed: kioskBreaksAllowed(config) });
    if (!plan.ok) throw new KioskBridgeError(plan.error, plan.status, "refused");

    let message: string;
    let tone: KioskActionPayload["tone"] = "success";
    if (plan.run === "start") {
      const type = resolveKioskShiftType((rawType as string | null | undefined) ?? null, allowedShiftTypes(config, member), config.kiosk.require_type);
      if (!type.ok) throw new KioskBridgeError(type.error, 400, "type_required");
      const result = await startShift(member, config, type.typeId, { via: "kiosk" });
      if (!result.ok) throw new KioskBridgeError(result.error, 409, "refused");
      const typeName = shiftTypeName(config, result.shift.typeId);
      message = `You're on shift${typeName ? ` (${typeName})` : ""}.`;
    } else if (plan.run === "toggle_break") {
      const result = await toggleBreak(member, config);
      if (!result.ok) throw new KioskBridgeError(result.error, 409, "refused");
      message = result.onBreak ? "You're on break. Your time is paused." : "Welcome back, your break is over.";
    } else {
      const result = await endOwnShift(member, config, { via: "kiosk" });
      if (!result.ok) throw new KioskBridgeError(result.error, 409, "refused");
      if (result.voided) {
        tone = "warning";
        message = `You're off shift. It was shorter than ${config.shifts.min_minutes} minutes, so it doesn't count.`;
      } else {
        message = `You're off shift after ${formatMinutes(shiftWorkedSeconds(result.shift) / 60)} (breaks: ${formatMinutes(result.shift.breakSeconds / 60)}).`;
      }
    }
    return { ok: true, message, tone, state: buildState(guild, runtime, member, tzOffset) };
  } finally {
    inFlight.delete(key);
  }
}

/** A background image for the kiosk, uploaded from the dashboard (re-encoded as PNG). */
export async function uploadKioskBackground(guildId: string, base64: string): Promise<{ assetId: string; bytes: number }> {
  return savePageAsset(guildId, "team_kiosk", decodeBase64Upload(base64));
}

export function readKioskBackground(guildId: string, assetId: string): Buffer | null {
  return readPageAsset(guildId, "team_kiosk", assetId);
}
