/**
 * AT Protocol OAuth for connecting a member's Bluesky account (no app passwords). The bot owns the
 * OAuth client and every token, since the bot is what likes/reposts/follows. The website only
 * serves the public pieces (client metadata, JWKS) and the redirect callback, each forwarded to
 * the bridge (see bridge/bluesky.ts).
 *
 * Production is a confidential client (`private_key_jwt`, key in BLUESKY_OAUTH_PRIVATE_JWK) whose
 * client_id is `<site>/api/bluesky/client-metadata.json`. When the site URL is localhost it falls
 * back to AT Protocol's loopback development client, which needs no keys or public URL.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { Agent } from "@atproto/api";
import {
  JoseKey,
  NodeOAuthClient,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
  requestLocalLock,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthClientMetadataInput,
} from "@atproto/oauth-client-node";
import { getDb } from "../../../db/client.js";
import { blueskyOauthStore } from "../../../db/schema.js";
import { getDashboardBridgeSecret, resolveSiteUrl } from "../../../bridge/env.js";
import { open, parseSecretKey, seal } from "../../../core/secretBox.js";
import { getLogger } from "../../../core/logger.js";
import { getProfile } from "./api.js";
import { deleteAccount, getAccount, getAccountByDid, upsertAccount, type BlueskyAccountRow } from "./accounts.js";
const log = getLogger("bluesky");

/** Least privilege: only the three record types Dreamliner ever writes. */
export const BLUESKY_OAUTH_SCOPE = "atproto repo:app.bsky.feed.like repo:app.bsky.feed.repost repo:app.bsky.graph.follow";

const STATE_TTL_MS = 60 * 60_000;
const APP_STATE_TTL_MS = 30 * 60_000;

export class BlueskyOauthError extends Error {}

export const NOT_CONFIGURED_MESSAGE = "Bluesky accounts aren't set up on this bot yet.";

function baseUrl(): string {
  return (process.env.BLUESKY_OAUTH_BASE_URL?.trim() || resolveSiteUrl()).replace(/\/$/, "");
}

function isLoopback(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);
}

function sessionKey(): Buffer | null {
  return parseSecretKey(process.env.BLUESKY_SESSION_SECRET);
}

/** True when this bot can run the connect flow at all. Feed notifications don't need any of it. */
export function isBlueskyOauthConfigured(): boolean {
  if (!sessionKey() || !getDashboardBridgeSecret()) return false;
  return isLoopback(baseUrl()) || Boolean(process.env.BLUESKY_OAUTH_PRIVATE_JWK?.trim());
}

// ---------------------------------------------------------------------------------------------
// Encrypted DB-backed stores for the OAuth client
// ---------------------------------------------------------------------------------------------

function dbStore<V>(kind: "session" | "state") {
  return {
    async get(key: string): Promise<V | undefined> {
      const row = await getDb()
        .select()
        .from(blueskyOauthStore)
        .where(and(eq(blueskyOauthStore.kind, kind), eq(blueskyOauthStore.key, key)))
        .get();
      if (!row) return undefined;
      const secret = sessionKey();
      if (!secret) return undefined;
      try {
        return JSON.parse(open(row.value, secret)) as V;
      } catch (error) {
        log.warn(`[bluesky] dropping unreadable OAuth ${kind} for ${key}:`, error);
        return undefined;
      }
    },
    async set(key: string, value: V): Promise<void> {
      const secret = sessionKey();
      if (!secret) throw new BlueskyOauthError(NOT_CONFIGURED_MESSAGE);
      const sealed = seal(JSON.stringify(value), secret);
      const now = new Date();
      await getDb()
        .insert(blueskyOauthStore)
        .values({ kind, key, value: sealed, updatedAt: now })
        .onConflictDoUpdate({ target: [blueskyOauthStore.kind, blueskyOauthStore.key], set: { value: sealed, updatedAt: now } })
        .run();
    },
    async del(key: string): Promise<void> {
      await getDb()
        .delete(blueskyOauthStore)
        .where(and(eq(blueskyOauthStore.kind, kind), eq(blueskyOauthStore.key, key)))
        .run();
    },
  };
}

/** Abandoned authorizations (the member never came back from Bluesky). */
export async function pruneOauthStates(): Promise<void> {
  const cutoff = new Date(Date.now() - STATE_TTL_MS);
  await getDb()
    .delete(blueskyOauthStore)
    .where(and(eq(blueskyOauthStore.kind, "state"), lt(blueskyOauthStore.updatedAt, cutoff)))
    .run();
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export function redirectUri(): string {
  const base = baseUrl();
  // Loopback clients must redirect to 127.0.0.1, not localhost (the website bounces it back).
  const origin = isLoopback(base) ? base.replace("://localhost", "://127.0.0.1") : base;
  return `${origin}/api/account/bluesky/callback`;
}

function clientMetadata(): OAuthClientMetadataInput {
  const base = baseUrl();
  if (isLoopback(base)) {
    const params = new URLSearchParams({ redirect_uri: redirectUri(), scope: BLUESKY_OAUTH_SCOPE });
    return {
      client_id: `http://localhost?${params.toString()}`,
      redirect_uris: [redirectUri() as `http://127.0.0.1${string}`],
      scope: BLUESKY_OAUTH_SCOPE,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "native",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    };
  }
  return {
    client_id: `${base}/api/bluesky/client-metadata.json`,
    client_name: "Dreamliner",
    client_uri: base,
    logo_uri: `${base}/logo.png`,
    tos_uri: `${base}/docs/terms-of-service`,
    policy_uri: `${base}/docs/privacy-policy`,
    redirect_uris: [redirectUri() as `https://${string}`],
    scope: BLUESKY_OAUTH_SCOPE,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}/api/bluesky/jwks.json`,
  };
}

let clientPromise: Promise<NodeOAuthClient> | null = null;

export function getOauthClient(): Promise<NodeOAuthClient> {
  if (!isBlueskyOauthConfigured()) return Promise.reject(new BlueskyOauthError(NOT_CONFIGURED_MESSAGE));
  clientPromise ??= (async () => {
    const loopback = isLoopback(baseUrl());
    const keyset = loopback ? undefined : [await JoseKey.fromImportable(process.env.BLUESKY_OAUTH_PRIVATE_JWK!.trim(), "dreamliner-1")];
    return new NodeOAuthClient({
      clientMetadata: clientMetadata(),
      keyset,
      stateStore: dbStore<NodeSavedState>("state"),
      sessionStore: dbStore<NodeSavedSession>("session"),
      requestLock: requestLocalLock,
    });
  })().catch((error: unknown) => {
    clientPromise = null;
    throw error;
  });
  return clientPromise;
}

/** Public client metadata + JWKS, served by the website at the URLs named in the metadata. */
export async function getPublicOauthDocuments(): Promise<{ metadata: unknown; jwks: { keys: Record<string, unknown>[] } }> {
  const client = await getOauthClient();
  // The library blanks private members to `undefined` (dropped by JSON), but strip them outright so
  // a private key can never be published even if that changes.
  const keys = client.jwks.keys.map((key) => {
    const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, k: _k, ...pub } = key as Record<string, unknown>;
    return JSON.parse(JSON.stringify(pub)) as Record<string, unknown>;
  });
  return { metadata: client.clientMetadata, jwks: { keys } };
}

// ---------------------------------------------------------------------------------------------
// App state: ties a callback back to the Discord user who started it
// ---------------------------------------------------------------------------------------------

function signAppState(discordUserId: string): string {
  const secret = getDashboardBridgeSecret();
  if (!secret) throw new BlueskyOauthError(NOT_CONFIGURED_MESSAGE);
  const payload = `${discordUserId}:${Date.now()}`;
  const signature = createHmac("sha256", secret).update(`bluesky:${payload}`).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

export function verifyAppState(appState: string | null, discordUserId: string): boolean {
  const secret = getDashboardBridgeSecret();
  if (!appState || !secret) return false;
  const [encoded, signature] = appState.split(".");
  if (!encoded || !signature) return false;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", secret).update(`bluesky:${payload}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [userId, issuedAtRaw] = payload.split(":");
  const issuedAt = Number(issuedAtRaw);
  return userId === discordUserId && Number.isFinite(issuedAt) && Date.now() - issuedAt <= APP_STATE_TTL_MS;
}

// ---------------------------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------------------------

/** Starts a connection and returns the Bluesky authorization URL to send the member to. */
export async function startAuthorize(discordUserId: string, handle: string): Promise<string> {
  const client = await getOauthClient();
  const input = handle.trim().replace(/^@/, "");
  if (!input) throw new BlueskyOauthError("Enter your Bluesky handle.");
  try {
    const url = await client.authorize(input.includes(".") || input.startsWith("did:") || input.startsWith("http") ? input : `${input}.bsky.social`, {
      scope: BLUESKY_OAUTH_SCOPE,
      state: signAppState(discordUserId),
    });
    return url.toString();
  } catch (error) {
    log.warn("[bluesky] authorize failed:", error);
    throw new BlueskyOauthError("Couldn't find that Bluesky account or its server. Check the handle and try again.");
  }
}

/** Finishes the redirect: exchanges the code, checks it belongs to this Discord user, stores the link. */
export async function completeCallback(discordUserId: string, params: URLSearchParams): Promise<BlueskyAccountRow> {
  const client = await getOauthClient();
  let result: Awaited<ReturnType<NodeOAuthClient["callback"]>>;
  try {
    result = await client.callback(params);
  } catch (error) {
    log.warn("[bluesky] callback failed:", error);
    throw new BlueskyOauthError("Bluesky didn't approve the connection. Please try again.");
  }
  const { session, state } = result;
  if (!verifyAppState(state, discordUserId)) {
    await session.signOut().catch(() => undefined);
    throw new BlueskyOauthError("This connection was started by a different Discord account, or it expired. Please try again.");
  }

  const profile = await getProfile(session.did).catch(() => null);
  const previous = await getAccount(discordUserId);
  if (previous && previous.did !== session.did) await revokeDid(previous.did);
  // One Bluesky account links to one Discord account; connecting it again moves the link here.
  const other = await getAccountByDid(session.did);
  if (other && other.discordUserId !== discordUserId) await deleteAccount(other.discordUserId);

  return upsertAccount({
    discordUserId,
    did: session.did,
    handle: profile?.handle ?? session.did,
    displayName: profile?.displayName ?? "",
    avatarUrl: profile?.avatarUrl ?? null,
  });
}

async function revokeDid(did: string): Promise<void> {
  try {
    const client = await getOauthClient();
    await client.revoke(did);
  } catch (error) {
    log.warn(`[bluesky] revoke failed for ${did}:`, error);
  }
}

/** Signs the member's session out on their PDS and forgets the link. */
export async function disconnect(discordUserId: string): Promise<boolean> {
  const account = await getAccount(discordUserId);
  if (!account) return false;
  await revokeDid(account.did);
  await deleteAccount(discordUserId);
  return true;
}

export type AgentResult =
  | { ok: true; agent: Agent; account: BlueskyAccountRow }
  | { ok: false; reason: "not_connected" | "expired" | "not_configured" | "unavailable" };

/** An authenticated agent for a member, refreshing tokens as needed. */
export async function getAgent(discordUserId: string): Promise<AgentResult> {
  if (!isBlueskyOauthConfigured()) return { ok: false, reason: "not_configured" };
  const account = await getAccount(discordUserId);
  if (!account) return { ok: false, reason: "not_connected" };
  try {
    const client = await getOauthClient();
    const session = await client.restore(account.did);
    return { ok: true, agent: new Agent(session), account };
  } catch (error) {
    const gone =
      error instanceof TokenRefreshError ||
      error instanceof TokenRevokedError ||
      error instanceof TokenInvalidError ||
      (error instanceof Error && /session.*(not found|deleted)/i.test(error.message));
    if (!gone) {
      log.warn(`[bluesky] couldn't restore the session for ${account.did}:`, error);
      return { ok: false, reason: "unavailable" };
    }
    // Refresh token expired or revoked on their PDS: the link is no longer usable.
    log.info(`[bluesky] session for ${account.did} expired; removing the link.`);
    await deleteAccount(discordUserId);
    return { ok: false, reason: "expired" };
  }
}
