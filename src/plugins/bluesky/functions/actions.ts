/**
 * Like / repost / follow as a member, through their connected account. Each action toggles: the
 * record Dreamliner created is remembered in `bluesky_actions`, so doing it again (or removing the
 * 💙 reaction) deletes exactly that record.
 */
import { getLogger } from "../../../core/logger.js";
import { deleteAction, getAction, saveAction, type BlueskyActionKind } from "./accounts.js";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { parseAtUri } from "./api.js";
import { getSession } from "./oauth.js";
const log = getLogger("bluesky");

export type ActionFailure = "not_connected" | "expired" | "not_configured" | "unavailable" | "rate_limited" | "failed";
export type ActionResult = { ok: true; state: "on" | "off"; handle: string } | { ok: false; reason: ActionFailure };

const WINDOW_MS = 60_000;
const MAX_ACTIONS_PER_WINDOW = 20;
const recentActions = new Map<string, number[]>();

/** In-memory sliding window per Discord user, so a reaction spree can't hammer their PDS. */
function throttled(discordUserId: string): boolean {
  const now = Date.now();
  const recent = (recentActions.get(discordUserId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_ACTIONS_PER_WINDOW) {
    recentActions.set(discordUserId, recent);
    return true;
  }
  recent.push(now);
  recentActions.set(discordUserId, recent);
  return false;
}

type Subject = { uri: string; cid?: string; did?: string };

const COLLECTION: Record<BlueskyActionKind, string> = {
  like: "app.bsky.feed.like",
  repost: "app.bsky.feed.repost",
  follow: "app.bsky.graph.follow",
};

/**
 * Plain XRPC through the member's DPoP-bound OAuth session. Deliberately not `@atproto/api`: its
 * generated types are huge and pushed `tsc` past the panel host's memory cap, and these two
 * record calls are all Dreamliner needs.
 */
async function repoCall(session: OAuthSession, method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await session.fetchHandler(`/xrpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${method} failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function createRecord(session: OAuthSession, kind: BlueskyActionKind, subject: Subject): Promise<string> {
  const record =
    kind === "follow"
      ? { $type: COLLECTION.follow, subject: subject.did, createdAt: new Date().toISOString() }
      : { $type: COLLECTION[kind], subject: { uri: subject.uri, cid: subject.cid }, createdAt: new Date().toISOString() };
  const created = (await repoCall(session, "com.atproto.repo.createRecord", {
    repo: session.did,
    collection: COLLECTION[kind],
    record,
  })) as { uri?: string } | null;
  if (!created?.uri) throw new Error("createRecord returned no uri");
  return created.uri;
}

async function deleteRecord(session: OAuthSession, recordUri: string): Promise<void> {
  const parsed = parseAtUri(recordUri);
  if (!parsed) return;
  await repoCall(session, "com.atproto.repo.deleteRecord", {
    repo: parsed.did,
    collection: parsed.collection,
    rkey: parsed.rkey,
  });
}

async function run(
  discordUserId: string,
  kind: BlueskyActionKind,
  subject: Subject,
  mode: "toggle" | "on" | "off",
): Promise<ActionResult> {
  const existing = await getAction(discordUserId, subject.uri, kind);
  const turnOff = mode === "off" || (mode === "toggle" && existing !== null);
  // Nothing Dreamliner made to undo (e.g. removing a reaction that never liked anything).
  if (turnOff && !existing) return { ok: true, state: "off", handle: "" };

  if (throttled(discordUserId)) return { ok: false, reason: "rate_limited" };
  const auth = await getSession(discordUserId);
  if (!auth.ok) return { ok: false, reason: auth.reason };
  const { session, account } = auth;

  try {
    if (turnOff) {
      if (existing) {
        await deleteRecord(session, existing);
        await deleteAction(discordUserId, subject.uri, kind);
      }
      return { ok: true, state: "off", handle: account.handle };
    }
    if (existing) return { ok: true, state: "on", handle: account.handle };

    const recordUri = await createRecord(session, kind, subject);
    await saveAction(discordUserId, subject.uri, kind, recordUri);
    return { ok: true, state: "on", handle: account.handle };
  } catch (error) {
    log.warn(`[bluesky] ${kind} ${turnOff ? "undo" : "create"} failed for ${account.did}:`, error);
    return { ok: false, reason: "failed" };
  }
}

export function toggleLike(discordUserId: string, uri: string, cid: string): Promise<ActionResult> {
  return run(discordUserId, "like", { uri, cid }, "toggle");
}

/** Reaction add: like (no-op if Dreamliner already liked it for them). */
export function like(discordUserId: string, uri: string, cid: string): Promise<ActionResult> {
  return run(discordUserId, "like", { uri, cid }, "on");
}

/** Reaction remove: undo only a like Dreamliner made. */
export function unlike(discordUserId: string, uri: string): Promise<ActionResult> {
  return run(discordUserId, "like", { uri }, "off");
}

export function toggleRepost(discordUserId: string, uri: string, cid: string): Promise<ActionResult> {
  return run(discordUserId, "repost", { uri, cid }, "toggle");
}

/** Follows are keyed by the followed DID as the "subject". */
export function toggleFollow(discordUserId: string, did: string): Promise<ActionResult> {
  return run(discordUserId, "follow", { uri: did, did }, "toggle");
}
