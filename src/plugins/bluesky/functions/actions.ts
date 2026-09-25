/**
 * Like / repost / follow as a member, through their connected account. Each action toggles: the
 * record Dreamliner created is remembered in `bluesky_actions`, so doing it again (or removing the
 * 💙 reaction) deletes exactly that record.
 */
import { getLogger } from "../../../core/logger.js";
import { deleteAction, getAction, saveAction, type BlueskyActionKind } from "./accounts.js";
import { getAgent } from "./oauth.js";
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
  const auth = await getAgent(discordUserId);
  if (!auth.ok) return { ok: false, reason: auth.reason };
  const { agent, account } = auth;

  try {
    if (turnOff) {
      if (existing) {
        if (kind === "like") await agent.deleteLike(existing);
        else if (kind === "repost") await agent.deleteRepost(existing);
        else await agent.deleteFollow(existing);
        await deleteAction(discordUserId, subject.uri, kind);
      }
      return { ok: true, state: "off", handle: account.handle };
    }
    if (existing) return { ok: true, state: "on", handle: account.handle };

    let created: { uri: string };
    if (kind === "like") created = await agent.like(subject.uri, subject.cid!);
    else if (kind === "repost") created = await agent.repost(subject.uri, subject.cid!);
    else created = await agent.follow(subject.did!);
    await saveAction(discordUserId, subject.uri, kind, created.uri);
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
