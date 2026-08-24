import type { Client } from "discord.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildOneSubscriptions } from "../db/schema.js";
import {
  getActiveDiscordEntitlement,
  listActiveDiscordEntitlements,
  refreshGuildDiscordOne,
} from "./oneEntitlements.js";

export const DREAMLINER_AERO_REQUIRED =
  "Custom Branding requires Dreamliner Aero.";

export type DreamlinerAeroPublicStatus = {
  active: boolean;
  forever: boolean;
  expiresAt: string | null;
  note: string | null;
};

export type DreamlinerAeroAdminStatus = DreamlinerAeroPublicStatus & {
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

function deriveStatus(row: SubscriptionRow | undefined, now = Date.now()): DreamlinerAeroAdminStatus {
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

function mergeAeroStatus(
  manual: DreamlinerAeroAdminStatus,
  entitlement:
    | {
        userId: string | null;
        startsAt: Date | null;
        endsAt: Date | null;
        updatedAt: Date;
      }
    | undefined,
): DreamlinerAeroAdminStatus {
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

export function toPublicStatus(admin: DreamlinerAeroAdminStatus): DreamlinerAeroPublicStatus {
  return {
    active: admin.active,
    forever: admin.forever,
    expiresAt: admin.expiresAt,
    note: admin.note,
  };
}

export async function getDreamlinerAeroRow(guildId: string): Promise<SubscriptionRow | undefined> {
  return getDb()
    .select()
    .from(guildOneSubscriptions)
    .where(eq(guildOneSubscriptions.guildId, guildId))
    .get();
}

export async function getDreamlinerAeroAdminStatus(guildId: string): Promise<DreamlinerAeroAdminStatus> {
  const [row, entitlement] = await Promise.all([
    getDreamlinerAeroRow(guildId),
    getActiveDiscordEntitlement(guildId),
  ]);
  return mergeAeroStatus(deriveStatus(row), entitlement);
}

export async function getDreamlinerAeroPublicStatus(guildId: string): Promise<DreamlinerAeroPublicStatus> {
  return toPublicStatus(await getDreamlinerAeroAdminStatus(guildId));
}

export async function isDreamlinerAeroActive(guildId: string): Promise<boolean> {
  if (await getActiveDiscordEntitlement(guildId)) return true;
  const status = deriveStatus(await getDreamlinerAeroRow(guildId));
  if (status.active) return true;
  return refreshGuildDiscordOne(guildId);
}

export async function listActiveAeroGuildIds(): Promise<Set<string>> {
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

export async function listPlatformDreamlinerAero(client: Client): Promise<{
  guilds: Array<{
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
    one: DreamlinerAeroAdminStatus;
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
      one: mergeAeroStatus(deriveStatus(byGuild.get(guild.id), now), discordByGuild.get(guild.id)),
    }))
    .sort((a, b) => {
      const rank = (status: DreamlinerAeroAdminStatus["status"]) => {
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

export async function upsertDreamlinerAero(input: {
  guildId: string;
  actorId: string;
  expiresAt: Date | null;
  note?: string | null;
}): Promise<DreamlinerAeroAdminStatus> {
  const now = new Date();
  const note =
    typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  const existing = await getDreamlinerAeroRow(input.guildId);

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

  return getDreamlinerAeroAdminStatus(input.guildId);
}

export async function revokeDreamlinerAero(
  guildId: string,
  actorId: string,
): Promise<DreamlinerAeroAdminStatus | null> {
  const existing = await getDreamlinerAeroRow(guildId);
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

  return getDreamlinerAeroAdminStatus(guildId);
}

export function parseExpiresAt(raw: unknown): Date | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date;
}
