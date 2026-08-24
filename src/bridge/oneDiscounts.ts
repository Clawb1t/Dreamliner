import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { oneDiscountCodes, oneDiscountRedemptions } from "../db/schema.js";
import { getDreamlinerAeroAdminStatus, upsertDreamlinerAero } from "./dreamlinerAero.js";

export type AeroDiscountCodeRow = {
  code: string;
  label: string | null;
  days: number | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
};

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function isCodeActive(
  row: typeof oneDiscountCodes.$inferSelect,
  now = Date.now(),
): boolean {
  if (row.revokedAt) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= now) return false;
  if (row.maxRedemptions != null && row.redemptionCount >= row.maxRedemptions) return false;
  return true;
}

function serialize(row: typeof oneDiscountCodes.$inferSelect): AeroDiscountCodeRow {
  return {
    code: row.code,
    label: row.label,
    days: row.days,
    maxRedemptions: row.maxRedemptions,
    redemptionCount: row.redemptionCount,
    expiresAt: toIso(row.expiresAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: toIso(row.revokedAt),
    active: isCodeActive(row),
  };
}

export async function listAeroDiscountCodes(): Promise<AeroDiscountCodeRow[]> {
  const rows = await getDb()
    .select()
    .from(oneDiscountCodes)
    .orderBy(desc(oneDiscountCodes.createdAt))
    .all();
  return rows.map(serialize);
}

export async function createAeroDiscountCode(input: {
  code: string;
  actorId: string;
  days: number | null;
  maxRedemptions: number | null;
  expiresAt: Date | null;
  label?: string | null;
}): Promise<AeroDiscountCodeRow> {
  const code = normalizeCode(input.code);
  if (code.length < 3 || code.length > 24) {
    throw new Error("Code must be 3 to 24 letters, numbers, dashes, or underscores.");
  }
  if (input.days != null && (!Number.isFinite(input.days) || input.days < 1 || input.days > 3650)) {
    throw new Error("Duration must be at least 1 day.");
  }
  if (
    input.maxRedemptions != null &&
    (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)
  ) {
    throw new Error("Max redemptions must be a positive whole number.");
  }

  const existing = await getDb()
    .select()
    .from(oneDiscountCodes)
    .where(eq(oneDiscountCodes.code, code))
    .get();
  if (existing && !existing.revokedAt) {
    throw new Error("That code already exists.");
  }

  const now = new Date();
  const values = {
    code,
    label: input.label?.trim() ? input.label.trim().slice(0, 120) : null,
    days: input.days,
    maxRedemptions: input.maxRedemptions,
    redemptionCount: existing?.redemptionCount ?? 0,
    expiresAt: input.expiresAt,
    createdBy: input.actorId,
    createdAt: now,
    revokedAt: null,
  };

  if (existing) {
    await getDb().update(oneDiscountCodes).set(values).where(eq(oneDiscountCodes.code, code));
  } else {
    await getDb().insert(oneDiscountCodes).values(values);
  }

  const row = await getDb()
    .select()
    .from(oneDiscountCodes)
    .where(eq(oneDiscountCodes.code, code))
    .get();
  if (!row) throw new Error("Failed to save discount code.");
  return serialize(row);
}

export async function revokeAeroDiscountCode(codeRaw: string): Promise<AeroDiscountCodeRow | null> {
  const code = normalizeCode(codeRaw);
  const existing = await getDb()
    .select()
    .from(oneDiscountCodes)
    .where(eq(oneDiscountCodes.code, code))
    .get();
  if (!existing) return null;
  if (!existing.revokedAt) {
    await getDb()
      .update(oneDiscountCodes)
      .set({ revokedAt: new Date() })
      .where(eq(oneDiscountCodes.code, code));
  }
  const row = await getDb()
    .select()
    .from(oneDiscountCodes)
    .where(eq(oneDiscountCodes.code, code))
    .get();
  return row ? serialize(row) : null;
}

export async function redeemAeroDiscountCode(input: {
  code: string;
  guildId: string;
  actorId: string;
}): Promise<{ one: Awaited<ReturnType<typeof upsertDreamlinerAero>>; discount: AeroDiscountCodeRow }> {
  const code = normalizeCode(input.code);
  const row = await getDb()
    .select()
    .from(oneDiscountCodes)
    .where(eq(oneDiscountCodes.code, code))
    .get();
  if (!row || !isCodeActive(row)) {
    throw new Error("That code is invalid or no longer active.");
  }

  const already = await getDb()
    .select()
    .from(oneDiscountRedemptions)
    .where(
      and(eq(oneDiscountRedemptions.code, code), eq(oneDiscountRedemptions.guildId, input.guildId)),
    )
    .get();
  if (already) {
    throw new Error("That server already redeemed this code.");
  }

  const current = await getDreamlinerAeroAdminStatus(input.guildId);
  if (current.active && current.forever) {
    throw new Error("That server already has Aero forever.");
  }

  let start = Date.now();
  if (current.active && current.expiresAt) {
    const existingEnd = new Date(current.expiresAt).getTime();
    if (Number.isFinite(existingEnd) && existingEnd > start) start = existingEnd;
  }
  const expiresAt = row.days == null ? null : new Date(start + row.days * 24 * 60 * 60 * 1000);
  const note = row.label?.trim()
    ? `Discount ${row.code}: ${row.label.trim()}`
    : `Discount ${row.code}`;

  const aero = await upsertDreamlinerAero({
    guildId: input.guildId,
    actorId: input.actorId,
    expiresAt,
    note,
  });

  const now = new Date();
  await getDb().insert(oneDiscountRedemptions).values({
    code,
    guildId: input.guildId,
    userId: input.actorId,
    redeemedAt: now,
  });
  await getDb()
    .update(oneDiscountCodes)
    .set({ redemptionCount: row.redemptionCount + 1 })
    .where(eq(oneDiscountCodes.code, code));

  const updated = await getDb()
    .select()
    .from(oneDiscountCodes)
    .where(eq(oneDiscountCodes.code, code))
    .get();
  // Field name stays "one" — the website's bot-bridge client keys off this
  // unchanged wire protocol field regardless of the Aero rebrand.
  return { one: aero, discount: updated ? serialize(updated) : serialize({ ...row, redemptionCount: row.redemptionCount + 1 }) };
}
