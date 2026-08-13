import type { Client } from "discord.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildOneSubscriptions } from "../db/schema.js";
import {
  getActiveDiscordEntitlement,
  listActiveDiscordEntitlements,
  refreshGuildDiscordOne,
} from "./oneEntitlements.js";

export const DREAMLINER_ONE_REQUIRED =
  "Custom Branding requires Dreamliner One.";

export type DreamlinerOnePublicStatus = {
  active: boolean;
  forever: boolean;
  expiresAt: string | null;
  note: string | null;
};

export type DreamlinerOneAdminStatus = DreamlinerOnePublicStatus & {
  status: "none" | "active" | "expired" | "revoked";
  grantedBy: string | null;
  grantedAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  revokedAt: string | null;
};

type SubscriptionRow = typeof guildOneSubscriptions.$inferSelect;

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function deriveStatus(row: SubscriptionRow | undefined, now = Date.now()): DreamlinerOneAdminStatus {
  if (!row) {
    return {
      active: false,
      forever: false,
      expiresAt: null,
      note: null,
      status: "none",
      grantedBy: null,
      grantedAt: null,
      updatedBy: null,
      updatedAt: null,
      revokedAt: null,
    };
  }

  const forever = row.expiresAt == null;
  const expiresAt = toIso(row.expiresAt);
  const revokedAt = toIso(row.revokedAt);
  const note = row.note?.trim() ? row.note.trim() : null;

  if (row.revokedAt) {
    return {
      active: false,
      forever: false,
      expiresAt,
      note,
      status: "revoked",
      grantedBy: row.grantedBy,
      grantedAt: toIso(row.grantedAt),
      updatedBy: row.updatedBy,
      updatedAt: toIso(row.updatedAt),
      revokedAt,
    };
  }

  const expired = row.expiresAt != null && row.expiresAt.getTime() <= now;
  if (expired) {
    return {
      active: false,
      forever: false,
      expiresAt,
      note,
      status: "expired",
      grantedBy: row.grantedBy,
      grantedAt: toIso(row.grantedAt),
      updatedBy: row.updatedBy,
      updatedAt: toIso(row.updatedAt),
      revokedAt: null,
    };
  }

  return {
    active: true,
    forever,
    expiresAt,
    note,
    status: "active",
    grantedBy: row.grantedBy,
    grantedAt: toIso(row.grantedAt),
    updatedBy: row.updatedBy,
    updatedAt: toIso(row.updatedAt),
    revokedAt: null,
  };
}

function mergeOneStatus(
  manual: DreamlinerOneAdminStatus,
  entitlement:
    | {
        userId: string | null;
        startsAt: Date | null;
        endsAt: Date | null;
        updatedAt: Date;
      }
    | undefined,
): DreamlinerOneAdminStatus {
  if (!entitlement) return manual;
  return {
    active: true,
    forever: false,
    expiresAt: toIso(entitlement.endsAt),
    note: manual.note ?? "Discord guild subscription",
    status: "active",
    grantedBy: entitlement.userId ?? "discord",
    grantedAt: toIso(entitlement.startsAt) ?? toIso(entitlement.updatedAt),
    updatedBy: entitlement.userId ?? "discord",
    updatedAt: toIso(entitlement.updatedAt),
    revokedAt: null,
  };
}

export function toPublicStatus(admin: DreamlinerOneAdminStatus): DreamlinerOnePublicStatus {
  return {
    active: admin.active,
    forever: admin.forever,
    expiresAt: admin.expiresAt,
    note: admin.note,
  };
}

export async function getDreamlinerOneRow(guildId: string): Promise<SubscriptionRow | undefined> {
  return getDb()
    .select()
    .from(guildOneSubscriptions)
    .where(eq(guildOneSubscriptions.guildId, guildId))
    .get();
}

export async function getDreamlinerOneAdminStatus(guildId: string): Promise<DreamlinerOneAdminStatus> {
  const [row, entitlement] = await Promise.all([
    getDreamlinerOneRow(guildId),
    getActiveDiscordEntitlement(guildId),
  ]);
  return mergeOneStatus(deriveStatus(row), entitlement);
}

export async function getDreamlinerOnePublicStatus(guildId: string): Promise<DreamlinerOnePublicStatus> {
  return toPublicStatus(await getDreamlinerOneAdminStatus(guildId));
}

export async function isDreamlinerOneActive(guildId: string): Promise<boolean> {
  if (await getActiveDiscordEntitlement(guildId)) return true;
  const status = deriveStatus(await getDreamlinerOneRow(guildId));
  if (status.active) return true;
  return refreshGuildDiscordOne(guildId);
}

export async function listActiveOneGuildIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const row of await listActiveDiscordEntitlements()) {
    ids.add(row.guildId);
  }
  const now = Date.now();
  const manuals = await getDb().select().from(guildOneSubscriptions).all();
  for (const row of manuals) {
    if (!row.revokedAt && (row.expiresAt == null || row.expiresAt.getTime() > now)) {
      ids.add(row.guildId);
    }
  }
  return ids;
}

export async function listPlatformDreamlinerOne(client: Client): Promise<{
  guilds: Array<{
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
    one: DreamlinerOneAdminStatus;
  }>;
}> {
  const rows = await getDb().select().from(guildOneSubscriptions).all();
  const byGuild = new Map(rows.map((row) => [row.guildId, row]));
  const discordByGuild = new Map(
    (await listActiveDiscordEntitlements()).map((row) => [row.guildId, row]),
  );
  const now = Date.now();

  const guilds = [...client.guilds.cache.values()]
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      memberCount: guild.memberCount,
      one: mergeOneStatus(deriveStatus(byGuild.get(guild.id), now), discordByGuild.get(guild.id)),
    }))
    .sort((a, b) => {
      const rank = (status: DreamlinerOneAdminStatus["status"]) => {
        if (status === "active") return 0;
        if (status === "expired") return 1;
        if (status === "revoked") return 2;
        return 3;
      };
      const delta = rank(a.one.status) - rank(b.one.status);
      if (delta !== 0) return delta;
      return a.name.localeCompare(b.name);
    });

  return { guilds };
}

export async function upsertDreamlinerOne(input: {
  guildId: string;
  actorId: string;
  expiresAt: Date | null;
  note?: string | null;
}): Promise<DreamlinerOneAdminStatus> {
  const now = new Date();
  const note =
    typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  const existing = await getDreamlinerOneRow(input.guildId);

  if (existing) {
    await getDb()
      .update(guildOneSubscriptions)
      .set({
        expiresAt: input.expiresAt,
        note,
        updatedBy: input.actorId,
        updatedAt: now,
        revokedAt: null,
      })
      .where(eq(guildOneSubscriptions.guildId, input.guildId));
  } else {
    await getDb().insert(guildOneSubscriptions).values({
      guildId: input.guildId,
      expiresAt: input.expiresAt,
      note,
      grantedBy: input.actorId,
      grantedAt: now,
      updatedBy: input.actorId,
      updatedAt: now,
      revokedAt: null,
    });
  }

  return getDreamlinerOneAdminStatus(input.guildId);
}

export async function revokeDreamlinerOne(
  guildId: string,
  actorId: string,
): Promise<DreamlinerOneAdminStatus | null> {
  const existing = await getDreamlinerOneRow(guildId);
  if (!existing) return null;

  const now = new Date();
  await getDb()
    .update(guildOneSubscriptions)
    .set({
      revokedAt: existing.revokedAt ?? now,
      updatedBy: actorId,
      updatedAt: now,
    })
    .where(eq(guildOneSubscriptions.guildId, guildId));

  return getDreamlinerOneAdminStatus(guildId);
}

export function parseExpiresAt(raw: unknown): Date | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date;
}
