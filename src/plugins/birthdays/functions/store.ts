import { and, count, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { birthdayCelebrations, birthdayOptouts, birthdayWishes, userBirthdays } from "../../../db/schema.js";
import type { Birthday } from "./dates.js";

export type StoredBirthday = Birthday & { userId: string; timezone: string | null };

function toStored(row: typeof userBirthdays.$inferSelect): StoredBirthday {
  return { userId: row.userId, month: row.month, day: row.day, year: row.year ?? null, timezone: row.timezone ?? null };
}

export function getBirthday(userId: string): StoredBirthday | null {
  const row = getDb().select().from(userBirthdays).where(eq(userBirthdays.userId, userId)).get();
  return row ? toStored(row) : null;
}

export function setBirthday(userId: string, birthday: Birthday, timezone: string | null): StoredBirthday {
  const now = new Date();
  const values = { month: birthday.month, day: birthday.day, year: birthday.year, timezone, updatedAt: now };
  getDb()
    .insert(userBirthdays)
    .values({ userId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: userBirthdays.userId, set: values })
    .run();
  return { userId, ...birthday, timezone };
}

export function removeBirthday(userId: string): boolean {
  return getDb().delete(userBirthdays).where(eq(userBirthdays.userId, userId)).run().changes > 0;
}

export function getBirthdays(userIds: string[]): Map<string, StoredBirthday> {
  const out = new Map<string, StoredBirthday>();
  for (let i = 0; i < userIds.length; i += 500) {
    const rows = getDb()
      .select()
      .from(userBirthdays)
      .where(inArray(userBirthdays.userId, userIds.slice(i, i + 500)))
      .all();
    for (const row of rows) out.set(row.userId, toStored(row));
  }
  return out;
}

/** Birthdays on any of these month/day pairs (timezones put "today" on up to three UTC dates). */
export function birthdaysOnDates(dates: Array<{ month: number; day: number }>): StoredBirthday[] {
  if (dates.length === 0) return [];
  const conditions = dates.map((d) => and(eq(userBirthdays.month, d.month), eq(userBirthdays.day, d.day)));
  return getDb().select().from(userBirthdays).where(or(...conditions)).all().map(toStored);
}

export function isOptedOut(guildId: string, userId: string): boolean {
  return Boolean(
    getDb()
      .select({ userId: birthdayOptouts.userId })
      .from(birthdayOptouts)
      .where(and(eq(birthdayOptouts.guildId, guildId), eq(birthdayOptouts.userId, userId)))
      .get(),
  );
}

export function setOptedOut(guildId: string, userId: string, optedOut: boolean): void {
  if (optedOut) {
    getDb().insert(birthdayOptouts).values({ guildId, userId, createdAt: new Date() }).onConflictDoNothing().run();
  } else {
    getDb()
      .delete(birthdayOptouts)
      .where(and(eq(birthdayOptouts.guildId, guildId), eq(birthdayOptouts.userId, userId)))
      .run();
  }
}

export function optedOutIn(guildId: string): Set<string> {
  return new Set(
    getDb()
      .select({ userId: birthdayOptouts.userId })
      .from(birthdayOptouts)
      .where(eq(birthdayOptouts.guildId, guildId))
      .all()
      .map((r) => r.userId),
  );
}

export type CelebrationRow = typeof birthdayCelebrations.$inferSelect;

/** How many birthdays this server celebrated since `since` (for {birthdays_today}). */
export function countCelebrationsSince(guildId: string, since: Date): number {
  const row = getDb()
    .select({ total: count() })
    .from(birthdayCelebrations)
    .where(and(eq(birthdayCelebrations.guildId, guildId), gte(birthdayCelebrations.celebratedAt, since)))
    .get();
  return Number(row?.total ?? 0);
}

/** "userId:year" keys already celebrated in this server, for the given members. */
export function celebratedKeys(guildId: string, userIds: string[]): Set<string> {
  if (userIds.length === 0) return new Set();
  return new Set(
    getDb()
      .select({ userId: birthdayCelebrations.userId, year: birthdayCelebrations.year })
      .from(birthdayCelebrations)
      .where(and(eq(birthdayCelebrations.guildId, guildId), inArray(birthdayCelebrations.userId, userIds)))
      .all()
      .map((r) => `${r.userId}:${r.year}`),
  );
}

/** Claims this year's celebration for a member (false if it already happened), so two ticks can
 *  never celebrate the same birthday twice. */
export function claimCelebration(guildId: string, userId: string, year: number, at: Date): boolean {
  return (
    getDb()
      .insert(birthdayCelebrations)
      .values({ guildId, userId, year, celebratedAt: at })
      .onConflictDoNothing()
      .run().changes > 0
  );
}

export function updateCelebration(
  guildId: string,
  userId: string,
  year: number,
  patch: Partial<Omit<CelebrationRow, "guildId" | "userId" | "year">>,
): void {
  getDb()
    .update(birthdayCelebrations)
    .set(patch)
    .where(
      and(
        eq(birthdayCelebrations.guildId, guildId),
        eq(birthdayCelebrations.userId, userId),
        eq(birthdayCelebrations.year, year),
      ),
    )
    .run();
}

export function celebrationsWithExpiredRoles(now: Date): CelebrationRow[] {
  return getDb()
    .select()
    .from(birthdayCelebrations)
    .where(
      and(
        isNotNull(birthdayCelebrations.roleId),
        isNull(birthdayCelebrations.roleRemovedAt),
        lte(birthdayCelebrations.roleExpiresAt, now),
      ),
    )
    .limit(100)
    .all();
}

export function celebrationsToDelete(now: Date): CelebrationRow[] {
  return getDb()
    .select()
    .from(birthdayCelebrations)
    .where(
      and(
        isNotNull(birthdayCelebrations.messageId),
        isNull(birthdayCelebrations.deletedAt),
        lte(birthdayCelebrations.deleteAt, now),
      ),
    )
    .limit(100)
    .all();
}

export function celebrationByMessage(messageId: string): CelebrationRow | null {
  return (
    getDb().select().from(birthdayCelebrations).where(eq(birthdayCelebrations.messageId, messageId)).get() ?? null
  );
}

/** Records a wish; false when this member already wished on this announcement. */
export function addWish(messageId: string, userId: string): boolean {
  return (
    getDb().insert(birthdayWishes).values({ messageId, userId, createdAt: new Date() }).onConflictDoNothing().run()
      .changes > 0
  );
}

export function countWishes(messageId: string): number {
  const row = getDb()
    .select({ total: count() })
    .from(birthdayWishes)
    .where(eq(birthdayWishes.messageId, messageId))
    .get();
  return Number(row?.total ?? 0);
}
