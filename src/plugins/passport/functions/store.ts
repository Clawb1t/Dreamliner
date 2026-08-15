import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { passportPending, passportVerifications } from "../../../db/schema.js";

export type PassportPendingRow = {
  guildId: string;
  userId: string;
  joinedAt: Date;
  expiresAt: Date | null;
  pingMessageId: string | null;
  pingChannelId: string | null;
  status: string;
};

export type PassportVerificationRow = {
  guildId: string;
  userId: string;
  verifiedAt: Date;
  method: string;
  accountCreatedAt: Date | null;
};

export async function getPassportPending(
  guildId: string,
  userId: string,
): Promise<PassportPendingRow | undefined> {
  return getDb()
    .select()
    .from(passportPending)
    .where(and(eq(passportPending.guildId, guildId), eq(passportPending.userId, userId)))
    .get();
}

export async function upsertPassportPending(input: {
  guildId: string;
  userId: string;
  joinedAt: Date;
  expiresAt: Date | null;
  pingMessageId: string | null;
  pingChannelId: string | null;
  status?: string;
}): Promise<void> {
  await getDb()
    .insert(passportPending)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      joinedAt: input.joinedAt,
      expiresAt: input.expiresAt,
      pingMessageId: input.pingMessageId,
      pingChannelId: input.pingChannelId,
      status: input.status ?? "pending",
    })
    .onConflictDoUpdate({
      target: [passportPending.guildId, passportPending.userId],
      set: {
        joinedAt: input.joinedAt,
        expiresAt: input.expiresAt,
        pingMessageId: input.pingMessageId,
        pingChannelId: input.pingChannelId,
        status: input.status ?? "pending",
      },
    });
}

export async function deletePassportPending(guildId: string, userId: string): Promise<void> {
  await getDb()
    .delete(passportPending)
    .where(and(eq(passportPending.guildId, guildId), eq(passportPending.userId, userId)));
}

export async function listExpiredPassportPending(now = new Date()): Promise<PassportPendingRow[]> {
  return getDb()
    .select()
    .from(passportPending)
    .where(
      and(
        eq(passportPending.status, "pending"),
        isNotNull(passportPending.expiresAt),
        lte(passportPending.expiresAt, now),
      ),
    )
    .all();
}

export async function getPassportVerification(
  guildId: string,
  userId: string,
): Promise<PassportVerificationRow | undefined> {
  return getDb()
    .select()
    .from(passportVerifications)
    .where(and(eq(passportVerifications.guildId, guildId), eq(passportVerifications.userId, userId)))
    .get();
}

export async function upsertPassportVerification(input: {
  guildId: string;
  userId: string;
  method: string;
  accountCreatedAt: Date | null;
}): Promise<void> {
  const verifiedAt = new Date();
  await getDb()
    .insert(passportVerifications)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      verifiedAt,
      method: input.method,
      accountCreatedAt: input.accountCreatedAt,
    })
    .onConflictDoUpdate({
      target: [passportVerifications.guildId, passportVerifications.userId],
      set: {
        verifiedAt,
        method: input.method,
        accountCreatedAt: input.accountCreatedAt,
      },
    });
}

export async function deletePassportVerification(guildId: string, userId: string): Promise<void> {
  await getDb()
    .delete(passportVerifications)
    .where(and(eq(passportVerifications.guildId, guildId), eq(passportVerifications.userId, userId)));
}
