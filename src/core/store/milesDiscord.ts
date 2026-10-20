import type { Client, Entitlement } from "discord.js";
import { registerIntervalTask } from "../scheduler.js";
import { getLogger } from "../logger.js";
import { getMilesEntitlementCursor, setMilesEntitlementCursor } from "./settings.js";
import { milesPackForSku, milesSkuIds, processMilesEntitlement, reconcileMilesEntitlements, type MilesEntitlementDeps } from "./miles.js";

const log = getLogger("store");

/** Wires Miles purchases to the live Discord client (see miles.ts for the flow). */

function depsFor(client: Client): MilesEntitlementDeps {
  return {
    consume: async (entitlementId) => {
      if (!client.application) throw new Error("Discord application is not ready.");
      await client.application.entitlements.consume(entitlementId);
    },
    notify: async (userId, message) => {
      const user = await client.users.fetch(userId);
      await user.send({ content: message, allowedMentions: { parse: [] } });
    },
  };
}

/** Events.EntitlementCreate / EntitlementUpdate: a Miles pack bought just now. */
export async function handleMilesEntitlement(client: Client, entitlement: Entitlement): Promise<void> {
  if (!milesPackForSku(entitlement.skuId)) return;
  try {
    await processMilesEntitlement(
      { id: entitlement.id, skuId: entitlement.skuId, userId: entitlement.userId, consumed: entitlement.consumed, deleted: entitlement.deleted },
      depsFor(client),
    );
  } catch (error) {
    log.error(`[miles] Failed to process entitlement ${entitlement.id}.`, error);
  }
}

export async function reconcileMiles(client: Client): Promise<void> {
  if (!client.application || milesSkuIds().length === 0) return;
  const app = client.application;
  const result = await reconcileMilesEntitlements(
    async ({ skus, after, limit }) => {
      const batch = await app.entitlements.fetch({ skus, after, limit, excludeDeleted: true, cache: false });
      return [...batch.values()].map((entitlement) => ({
        id: entitlement.id,
        skuId: entitlement.skuId,
        userId: entitlement.userId,
        consumed: entitlement.consumed,
        deleted: entitlement.deleted,
      }));
    },
    depsFor(client),
    { get: getMilesEntitlementCursor, set: setMilesEntitlementCursor },
  );
  if (result.processed > 0) log.info(`[miles] Reconciled ${result.processed} Miles entitlement(s), ${result.granted} newly paid.`);
}

/** On ready: reconcile once, then every 10 minutes. */
export function startMilesEntitlements(client: Client): void {
  const skus = milesSkuIds();
  if (skus.length === 0) {
    log.info("[miles] No DISCORD_MILES_SKU_* set, so Miles purchases are off.");
    return;
  }
  log.info(`[miles] Tracking Miles SKUs: ${skus.join(", ")}`);
  void reconcileMiles(client).catch((error) => log.warn("[miles] Startup reconcile failed.", error));
  registerIntervalTask({
    id: "store:miles-reconcile",
    intervalMs: 10 * 60_000,
    run: async (live) => {
      await reconcileMiles(live);
    },
  });
}
