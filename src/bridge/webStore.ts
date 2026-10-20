import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import {
  type LedgerKind,
  StorePurchaseError,
  claimUncreditedVotes,
  countUncreditedVotes,
  creditVote,
  getCreditBalance,
  getVoteSummary,
  listLedger,
  recordVote,
} from "../core/store/credits.js";
import {
  DREAMLINER_ONE_PRODUCT_ID,
  findPurchaseByRequest,
  getProduct,
  productDisplayName,
  listEntitlements,
  purchaseErrorStatus,
  purchaseProduct,
  type Currency,
  type PurchaseReceipt,
} from "../core/store/products.js";
import { getMilesBalance } from "../core/store/miles.js";
import { STORE_PRICING, type StorePricing } from "../core/store/pricing.js";
import { isVoteHistoryConfigured, syncVoteHistory } from "../core/store/topggVotes.js";
import { VOTE_URL } from "../core/docsUrl.js";
import { getActiveDiscordEntitlement } from "./oneEntitlements.js";
import { getDreamlinerOneRow } from "./dreamlinerOne.js";
import { getLogger } from "../core/logger.js";
import { isDashboardSuperuser } from "./superuser.js";
import { setVoteReminders, voteRemindersEnabled } from "../core/store/voteReminders.js";

const log = getLogger("store");

/** top.gg lets a member vote again 12 hours after their last vote. */
const VOTE_COOLDOWN_MS = 12 * 60 * 60_000;

export type WebStoreHistoryEntry = {
  id: number;
  kind: LedgerKind;
  /** Which balance this row moved. */
  currency: Currency;
  delta: number;
  createdAt: string;
  guild: { id: string; name: string; icon: string | null } | null;
  days: number | null;
  /** Purchases: the product bought. */
  product: { id: string; name: string } | null;
};

export type WebStoreOwned = { productId: string; guildId: string | null; days: number | null; createdAt: string };

export type WebStoreOverview = {
  /** Credits balance. */
  balance: number;
  /** Miles balance. */
  miles: number;
  pricing: StorePricing;
  voteUrl: string;
  votes: { total: number; lastVotedAt: string | null; nextVoteAt: string | null };
  /** Recorded votes not paid out yet (past votes waiting to be claimed). */
  claimable: number;
  /** False until the bot has a top.gg v1 token, so past votes can't be looked up yet. */
  historyAvailable: boolean;
  history: WebStoreHistoryEntry[];
  /** Whether the member gets a DM when they can vote again (on unless they turned it off). */
  reminders: boolean;
  /** Everything the member bought from the store, newest first. */
  owned: WebStoreOwned[];
};

function guildSummary(client: Client, guildId: string | null) {
  if (!guildId) return null;
  const guild = client.guilds.cache.get(guildId);
  return { id: guildId, name: guild?.name ?? "Unknown server", icon: guild?.icon ?? null };
}

export function getWebStoreOverview(client: Client, userId: string): WebStoreOverview {
  const votes = getVoteSummary(userId);
  const nextVoteAt =
    votes.lastVotedAt && votes.lastVotedAt.getTime() + VOTE_COOLDOWN_MS > Date.now()
      ? new Date(votes.lastVotedAt.getTime() + VOTE_COOLDOWN_MS).toISOString()
      : null;
  return {
    balance: getCreditBalance(userId),
    miles: getMilesBalance(userId),
    pricing: STORE_PRICING,
    voteUrl: VOTE_URL,
    votes: { total: votes.total, lastVotedAt: votes.lastVotedAt?.toISOString() ?? null, nextVoteAt },
    claimable: countUncreditedVotes(userId),
    historyAvailable: isVoteHistoryConfigured(),
    history: listLedger(userId, 30).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      currency: entry.currency,
      delta: entry.delta,
      createdAt: entry.createdAt.toISOString(),
      guild: guildSummary(client, entry.guildId),
      days: entry.days,
      product: entry.productId ? { id: entry.productId, name: productDisplayName(entry.productId) } : null,
    })),
    reminders: voteRemindersEnabled(userId),
    owned: listEntitlements(userId).map((owned) => ({
      productId: owned.productId,
      guildId: owned.guildId,
      days: owned.days,
      createdAt: owned.createdAt.toISOString(),
    })),
  };
}

export function setWebVoteReminders(client: Client, userId: string, enabled: boolean): WebStoreOverview {
  setVoteReminders(userId, enabled);
  return getWebStoreOverview(client, userId);
}

/** A vote delivered by the top.gg webhook (already signature-checked by the website). */
export function recordWebhookVote(input: {
  userId: string;
  votedAt: Date;
  topggVoteId: string | null;
  weight: number;
}): { credited: number } {
  const voteId = recordVote({ ...input, source: "webhook" });
  const credited = creditVote(voteId, input.userId);
  log.info(`[store] Vote from ${input.userId} recorded (+${credited} credits).`);
  return { credited };
}

export type WebClaimResult =
  | { ok: true; votes: number; credits: number; overview: WebStoreOverview; syncError?: string }
  | { ok: false; error: string };

/** Looks up the latest vote history, then pays every vote of this member not paid yet. */
export async function claimWebStoreVotes(client: Client, userId: string): Promise<WebClaimResult> {
  const sync = await syncVoteHistory();
  const claimed = claimUncreditedVotes(userId);
  return {
    ok: true,
    ...claimed,
    overview: getWebStoreOverview(client, userId),
    ...(sync.ok ? {} : { syncError: "top.gg's vote history couldn't be reached right now, so only votes already on record were counted." }),
  };
}

export type WebStoreServer = {
  id: string;
  name: string;
  icon: string | null;
  one: { active: boolean; source: "subscription" | "grant" | null; forever: boolean; expiresAt: string | null };
  /** Why credits can't be spent here, or null when they can. */
  blockedReason: "subscription" | "forever" | null;
};

/** The given servers (the ones the member can manage, from Discord) that Dreamliner is in, with
 *  their One state. The website filters to manageable servers; purchases re-check it here. */
export async function listWebStoreServers(client: Client, guildIds: string[], userId: string): Promise<WebStoreServer[]> {
  const now = Date.now();
  const servers: WebStoreServer[] = [];
  // Superusers pick from every server the bot is in, so the cap is generous.
  for (const guildId of [...new Set(guildIds)].slice(0, 5000)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    // Only servers this person could actually buy for (the purchase itself checks the same).
    if (!(await canManage(guild, userId))) continue;
    const [entitlement, row] = await Promise.all([getActiveDiscordEntitlement(guildId), getDreamlinerOneRow(guildId)]);
    const grantActive = Boolean(row && !row.revokedAt && (row.expiresAt === null || row.expiresAt.getTime() > now));
    const forever = grantActive && row?.expiresAt === null;
    servers.push({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      one: entitlement
        ? { active: true, source: "subscription", forever: false, expiresAt: entitlement.endsAt?.toISOString() ?? null }
        : { active: grantActive, source: grantActive ? "grant" : null, forever, expiresAt: grantActive ? (row?.expiresAt?.toISOString() ?? null) : null },
      blockedReason: entitlement ? "subscription" : forever ? "forever" : null,
    });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Same rule as the dashboard (memberCanManage in dashboardBridge.ts): platform superusers, the
 *  owner, or a member with Administrator or Manage Server. */
async function canManage(guild: Guild, userId: string): Promise<boolean> {
  if (isDashboardSuperuser(userId)) return true;
  if (guild.ownerId === userId) return true;
  const member = await guild.members.fetch(userId).catch(() => null);
  return Boolean(
    member?.permissions.has(PermissionFlagsBits.Administrator) || member?.permissions.has(PermissionFlagsBits.ManageGuild),
  );
}

export type WebPurchaseResult =
  | {
      ok: true;
      cost: number;
      /** The currency charged. */
      currency: Currency;
      /** The balance of `currency` after the purchase. */
      balance: number;
      expiresAt: string;
      /** Cosmetics delivered (a bundle only delivers the items not owned yet). */
      grantedProductIds: string[];
      overview: WebStoreOverview;
      product: { id: string; name: string };
    }
  | { ok: false; status: number; error: string; code?: string };

function purchaseSuccess(client: Client, userId: string, receipt: PurchaseReceipt): WebPurchaseResult {
  return {
    ok: true,
    cost: receipt.cost,
    currency: receipt.currency,
    balance: receipt.balance,
    expiresAt: receipt.expiresAt?.toISOString() ?? "",
    grantedProductIds: receipt.grantedProductIds,
    overview: getWebStoreOverview(client, userId),
    product: receipt.product,
  };
}

/** Buys a store product. A requestId already bought returns that purchase's result again (no
 *  second charge), so a double submit or a retried request is safe. */
export async function purchaseWebStoreProduct(
  client: Client,
  userId: string,
  request: { productId: string; input: Record<string, unknown>; requestId: string | null; currency?: Currency | null },
): Promise<WebPurchaseResult> {
  if (request.requestId) {
    const previous = findPurchaseByRequest(userId, request.requestId);
    if (previous && previous.product.id === request.productId) return purchaseSuccess(client, userId, previous);
  }

  const product = getProduct(request.productId);
  if (!product) return { ok: false, status: 404, error: "That product isn't in the store." };

  if (product.type === "one_days" && request.currency === "miles") {
    return { ok: false, status: 400, error: `${product.name} can only be bought with credits.`, code: "wrong_currency" };
  }

  if (product.type === "one_days") {
    const guildId = typeof request.input.guildId === "string" ? request.input.guildId : "";
    if (!guildId) return { ok: false, status: 400, error: "Pick a server to add Dreamliner One to." };
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return { ok: false, status: 404, error: "Dreamliner isn't in that server." };
    if (!(await canManage(guild, userId))) {
      return { ok: false, status: 403, error: "You need Manage Server in that server to add Dreamliner One to it." };
    }
    if (await getActiveDiscordEntitlement(guildId)) {
      return {
        ok: false,
        status: 409,
        error: "That server already has a Dreamliner One subscription, so credits can't add to it.",
      };
    }
  }

  try {
    const receipt = purchaseProduct({
      userId,
      productId: product.id,
      input: request.input,
      requestId: request.requestId,
      currency: request.currency ?? null,
    });
    if (!receipt.replayed) {
      log.info(
        `[store] ${userId} bought ${product.id}${receipt.days ? ` (${receipt.days} days)` : ""}${receipt.guildId ? ` for ${receipt.guildId}` : ""} (${receipt.cost} ${receipt.currency === "miles" ? "Miles" : "credits"}).`,
      );
    }
    return purchaseSuccess(client, userId, receipt);
  } catch (error) {
    if (error instanceof StorePurchaseError) {
      return { ok: false, status: purchaseErrorStatus(error.code), error: error.message, code: error.code };
    }
    throw error;
  }
}

/** The pre-catalog purchase: days of Dreamliner One for a server. */
export async function purchaseWebStoreOne(
  client: Client,
  userId: string,
  guildId: string,
  days: number,
  requestId: string | null = null,
): Promise<WebPurchaseResult> {
  return purchaseWebStoreProduct(client, userId, { productId: DREAMLINER_ONE_PRODUCT_ID, input: { guildId, days }, requestId });
}
