import { and, eq } from "drizzle-orm";
import { SKUType, type Client, type Entitlement } from "discord.js";
import { getDb } from "../db/client.js";
import { guildOneEntitlements } from "../db/schema.js";
import { registerIntervalTask } from "../core/scheduler.js";

export const DREAMLINER_ONE_APPLICATION_ID = "1524053555114151946";
export const DREAMLINER_ONE_SKU_ID_DEFAULT = "1537178843033501727";

type EntitlementRow = typeof guildOneEntitlements.$inferSelect;

let resolvedSkuIds = new Set<string>([getConfiguredOneSkuId()]);
let entitlementsClient: Client | null = null;

function requireApplication(client: Client) {
  if (!client.application) {
    throw new Error("Discord application is not ready.");
  }
  return client.application;
}

// Env var name stays DREAMLINER_ONE_SKU_ID — unchanged deployment config key
// (see rebrand plan; renaming it needs a lockstep PebbleHost env change).
export function getConfiguredOneSkuId(): string {
  return process.env.DREAMLINER_ONE_SKU_ID?.trim() || DREAMLINER_ONE_SKU_ID_DEFAULT;
}

export function getDreamlinerOneSkuIds(): string[] {
  return [...resolvedSkuIds];
}

export function isDreamlinerOneSku(skuId: string): boolean {
  return resolvedSkuIds.has(skuId);
}

export function getDreamlinerOneClient(): Client | null {
  return entitlementsClient;
}

function isRowActive(row: EntitlementRow, now = Date.now()): boolean {
  if (row.deleted) return false;
  if (row.endsAt != null && row.endsAt.getTime() <= now) return false;
  return true;
}

export async function resolveDreamlinerOneSkus(client: Client): Promise<void> {
  const configured = getConfiguredOneSkuId();
  const ids = new Set<string>([configured]);
  try {
    const skus = await requireApplication(client).fetchSKUs();
    for (const sku of skus.values()) {
      if (sku.id === configured || sku.flags.has("GuildSubscription")) {
        ids.add(sku.id);
      }
      if (sku.id === configured && sku.type === SKUType.SubscriptionGroup) {
        for (const other of skus.values()) {
          if (other.type === SKUType.Subscription) ids.add(other.id);
        }
      }
    }
  } catch (error) {
    console.warn("[dreamliner-one] Failed to list SKUs; using configured SKU only.", error);
  }
  resolvedSkuIds = ids;
  console.log(`[dreamliner-one] Tracking SKUs: ${[...ids].join(", ")}`);
}

export async function upsertDiscordEntitlement(entitlement: Entitlement): Promise<void> {
  if (!isDreamlinerOneSku(entitlement.skuId)) return;
  if (!entitlement.guildId) {
    console.warn(
      `[dreamliner-one] Ignoring entitlement ${entitlement.id} with no guild (not a guild SKU).`,
    );
    return;
  }

  const now = new Date();
  const values = {
    entitlementId: entitlement.id,
    guildId: entitlement.guildId,
    skuId: entitlement.skuId,
    userId: entitlement.userId ?? null,
    startsAt: entitlement.startsAt,
    endsAt: entitlement.endsAt,
    deleted: Boolean(entitlement.deleted),
    updatedAt: now,
  };

  const existing = await getDb()
    .select()
    .from(guildOneEntitlements)
    .where(eq(guildOneEntitlements.entitlementId, entitlement.id))
    .get();

  if (existing) {
    await getDb()
      .update(guildOneEntitlements)
      .set(values)
      .where(eq(guildOneEntitlements.entitlementId, entitlement.id));
  } else {
    await getDb().insert(guildOneEntitlements).values(values);
  }

  if (entitlement.isActive()) {
    console.log(`[dreamliner-one] Active in guild ${entitlement.guildId} (entitlement ${entitlement.id}).`);
  }
}

export async function markDiscordEntitlementDeleted(entitlementId: string): Promise<void> {
  await getDb()
    .update(guildOneEntitlements)
    .set({ deleted: true, updatedAt: new Date() })
    .where(eq(guildOneEntitlements.entitlementId, entitlementId));
}

export async function getActiveDiscordEntitlement(guildId: string): Promise<EntitlementRow | undefined> {
  const rows = await getDb()
    .select()
    .from(guildOneEntitlements)
    .where(and(eq(guildOneEntitlements.guildId, guildId), eq(guildOneEntitlements.deleted, false)))
    .all();
  return rows.find((row) => isRowActive(row));
}

export async function listActiveDiscordEntitlements(): Promise<EntitlementRow[]> {
  const rows = await getDb().select().from(guildOneEntitlements).all();
  return rows.filter((row) => isRowActive(row));
}

export async function guildHasDiscordOne(guildId: string): Promise<boolean> {
  return Boolean(await getActiveDiscordEntitlement(guildId));
}

async function fetchGuildEntitlementFromDiscord(
  client: Client,
  guildId: string,
): Promise<Entitlement | null> {
  const skus = getDreamlinerOneSkuIds();
  const batch = await requireApplication(client).entitlements.fetch({
    guild: guildId,
    skus,
    excludeEnded: true,
    excludeDeleted: true,
  });
  for (const entitlement of batch.values()) {
    if (entitlement.guildId === guildId && entitlement.isActive() && isDreamlinerOneSku(entitlement.skuId)) {
      return entitlement;
    }
  }
  return null;
}

export async function refreshGuildDiscordOne(guildId: string): Promise<boolean> {
  const client = entitlementsClient;
  if (!client?.application) return guildHasDiscordOne(guildId);
  try {
    const live = await fetchGuildEntitlementFromDiscord(client, guildId);
    if (live) {
      await upsertDiscordEntitlement(live);
      return true;
    }
  } catch (error) {
    console.warn(`[dreamliner-one] Live entitlement check failed for ${guildId}.`, error);
  }
  return guildHasDiscordOne(guildId);
}

export async function syncAllDiscordEntitlements(client: Client): Promise<void> {
  const skus = getDreamlinerOneSkuIds();
  let after: string | undefined;
  let stored = 0;

  for (let page = 0; page < 50; page += 1) {
    const batch = await requireApplication(client).entitlements.fetch({
      skus,
      excludeDeleted: true,
      limit: 100,
      after,
    });
    if (batch.size === 0) break;
    const ids = [...batch.keys()].sort();
    for (const entitlement of batch.values()) {
      if (!entitlement.guildId || !isDreamlinerOneSku(entitlement.skuId)) continue;
      await upsertDiscordEntitlement(entitlement);
      stored += 1;
    }
    if (batch.size < 100) break;
    after = ids[ids.length - 1];
  }

  console.log(`[dreamliner-one] Synced ${stored} Discord entitlement(s).`);
}

export async function handleDiscordEntitlement(entitlement: Entitlement): Promise<void> {
  try {
    await upsertDiscordEntitlement(entitlement);
  } catch (error) {
    console.error("[dreamliner-one] Failed to persist entitlement.", error);
  }
}

export async function handleDiscordEntitlementDelete(entitlement: Entitlement): Promise<void> {
  try {
    await markDiscordEntitlementDeleted(entitlement.id);
  } catch (error) {
    console.error("[dreamliner-one] Failed to delete entitlement.", error);
  }
}

export async function startDreamlinerOneEntitlements(client: Client): Promise<void> {
  entitlementsClient = client;
  await resolveDreamlinerOneSkus(client);
  try {
    await syncAllDiscordEntitlements(client);
  } catch (error) {
    console.warn("[dreamliner-one] Startup entitlement sync failed.", error);
  }

  registerIntervalTask({
    id: "dreamliner-one-entitlements",
    intervalMs: 15 * 60 * 1000,
    run: async (c) => {
      await resolveDreamlinerOneSkus(c);
      await syncAllDiscordEntitlements(c);
    },
  });
}

export async function createGuildOneTestEntitlement(
  client: Client,
  guildId: string,
): Promise<{ id: string; guildId: string }> {
  const app = requireApplication(client);
  const entitlement = await app.entitlements.createTest({
    sku: getConfiguredOneSkuId(),
    guild: guildId,
  });
  await upsertDiscordEntitlement(entitlement);
  return { id: entitlement.id, guildId: entitlement.guildId ?? guildId };
}

export async function deleteGuildOneTestEntitlements(
  client: Client,
  guildId: string,
): Promise<{ deleted: number }> {
  const app = requireApplication(client);
  const batch = await app.entitlements.fetch({
    guild: guildId,
    skus: getDreamlinerOneSkuIds(),
    excludeEnded: false,
    excludeDeleted: true,
  });
  let deleted = 0;
  for (const entitlement of batch.values()) {
    if (entitlement.guildId !== guildId) continue;
    try {
      await app.entitlements.deleteTest(entitlement);
      await markDiscordEntitlementDeleted(entitlement.id);
      deleted += 1;
    } catch {
      // Paid Discord subscriptions cannot be deleted this way.
    }
  }
  return { deleted };
}
