import type { Client, Guild } from "discord.js";
import { getLogger } from "../../../core/logger.js";
import { POST_RETENTION_MS, SCHEDULE_MAX_FAILURES } from "./constants.js";
import { nextRunAt, type ScheduleRepeat } from "./schedule.js";
import { deletePost, describeDiscordError, loadKitsRuntime, logKitEvent, sendKitToTarget } from "./send.js";
import { dueSchedules, getKit, getPost, pruneDeletedPosts, updateSchedule, type KitPostRecord, type KitScheduleRecord } from "./store.js";

const log = getLogger("message_kits");

/** A one-off send that failed is retried this long after. */
const ONE_OFF_RETRY_MS = 5 * 60_000;
const BATCH = 20;

export function ruleOf(schedule: KitScheduleRecord) {
  return {
    repeat: schedule.repeat as ScheduleRepeat,
    timeOfDay: schedule.timeOfDay,
    timezone: schedule.timezone,
    weekday: schedule.weekday,
    monthDay: schedule.monthDay,
  };
}

/** Sends a schedule's kit now (also "Run now" on the dashboard). Replaces the previous copy when asked. */
export async function runScheduleNow(client: Client, guild: Guild, schedule: KitScheduleRecord, userId: string | null): Promise<KitPostRecord> {
  const kit = getKit(guild.id, schedule.kitId);
  if (!kit) throw new Error("The kit for this schedule was deleted.");
  const post = await sendKitToTarget(client, guild, kit, {
    channelId: schedule.channelId,
    threadId: schedule.threadId,
    userId: userId ?? schedule.createdBy,
    reason: userId ? "dashboard" : "schedule",
  });
  if (schedule.replacePrevious && schedule.lastPostId) {
    const previous = getPost(guild.id, schedule.lastPostId);
    if (previous && !previous.deletedAt) await deletePost(client, guild, previous, kit.name).catch(() => undefined);
  }
  updateSchedule(schedule.id, { lastPostId: post.id, lastRunAt: new Date(), lastError: null, failCount: 0 });
  return post;
}

async function runDue(client: Client, schedule: KitScheduleRecord): Promise<void> {
  const now = Date.now();
  const repeats = schedule.repeat !== "none";
  // Claim first: work out (and save) the next run before sending, so a crash or restart mid-send
  // can't send the same occurrence twice.
  const next = repeats ? nextRunAt(ruleOf(schedule), now) : null;
  updateSchedule(schedule.id, { nextRunAt: next === null ? null : new Date(next), lastRunAt: new Date(now) });

  const guild = client.guilds.cache.get(schedule.guildId);
  if (!guild) {
    updateSchedule(schedule.id, { enabled: false, lastError: "Dreamliner isn't in this server any more." });
    return;
  }
  const runtime = await loadKitsRuntime(guild.id);
  if (!runtime.enabled) {
    // Skipped, not failed: turning the plugin back on resumes recurring schedules.
    updateSchedule(schedule.id, { lastError: "Skipped: Message Kits is turned off.", ...(repeats ? {} : { enabled: false }) });
    return;
  }

  try {
    await runScheduleNow(client, guild, schedule, null);
    if (!repeats) updateSchedule(schedule.id, { enabled: false });
  } catch (error) {
    const message = describeDiscordError(error);
    const failCount = schedule.failCount + 1;
    const disable = failCount >= SCHEDULE_MAX_FAILURES;
    updateSchedule(schedule.id, {
      failCount,
      lastError: message,
      ...(disable ? { enabled: false } : {}),
      ...(!repeats && !disable ? { nextRunAt: new Date(now + ONE_OFF_RETRY_MS) } : {}),
    });
    if (disable) {
      const kit = getKit(guild.id, schedule.kitId);
      void logKitEvent(
        client,
        guild,
        "Schedule turned off",
        `The schedule for **${kit?.name ?? "a deleted kit"}** in <#${schedule.threadId ?? schedule.channelId}> failed ${failCount} times in a row and was turned off. Last error: ${message}`,
      );
    }
  }
}

let running = false;

/** Every 30 seconds: sends whatever is due (next_run_at ≤ now), oldest first. */
export async function runDueSchedules(client: Client): Promise<void> {
  if (running || !client?.isReady()) return;
  running = true;
  try {
    for (const schedule of dueSchedules(new Date(), BATCH)) {
      await runDue(client, schedule).catch((error) => log.error(`Message Kits schedule ${schedule.id} failed:`, error));
    }
  } finally {
    running = false;
  }
}

export async function pruneKitPosts(): Promise<void> {
  const removed = pruneDeletedPosts(new Date(Date.now() - POST_RETENTION_MS));
  if (removed) log.info(`Forgot ${removed} deleted Message Kit copies.`);
}
