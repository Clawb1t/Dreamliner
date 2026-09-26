import { createHmac, timingSafeEqual } from "node:crypto";
import { getDashboardBridgeSecret } from "../../bridge/env.js";

const TOKEN_VALIDITY_MS = 30 * 60 * 1000;

/** Stateless "this session already paid the AI gate" capability token, so a multi-turn wizard
 * only spends the shared free-use gate once (on the first message) instead of once per question,
 * without needing a session table. Signed with the bridge secret so a client can't forge one to
 * skip the gate on a guild that has already used its free generation. */
export function issueWizardSessionToken(guildId: string): string {
  const secret = getDashboardBridgeSecret();
  if (!secret) throw new Error("Dashboard bridge secret is not configured.");
  const issuedAt = Date.now();
  const payload = `${guildId}:${issuedAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

export function verifyWizardSessionToken(guildId: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const secret = getDashboardBridgeSecret();
  if (!secret) return false;

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return false;

  const payload = Buffer.from(encodedPayload, "base64url").toString("utf-8");
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const [tokenGuildId, issuedAtRaw] = payload.split(":");
  if (tokenGuildId !== guildId) return false;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;

  return Date.now() - issuedAt <= TOKEN_VALIDITY_MS;
}

const SWITCH_TOKEN_VALIDITY_MS = 6 * 60 * 60 * 1000;

function signSwitchPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`switch:${payload}`).digest("base64url");
}

/** Like the wizard token, but for a whole Switch (MEE6/Dyno import) run: one Autopilot use covers
 * every screenshot read and every per-category wizard for 6 hours. Signed with a distinct prefix
 * so a regular 30-minute wizard token can't be passed off as one. */
export function issueSwitchSessionToken(guildId: string): string {
  const secret = getDashboardBridgeSecret();
  if (!secret) throw new Error("Dashboard bridge secret is not configured.");
  const payload = `${guildId}:${Date.now()}`;
  return `sw.${Buffer.from(payload).toString("base64url")}.${signSwitchPayload(payload, secret)}`;
}

export function verifySwitchSessionToken(guildId: string, token: string | undefined | null): boolean {
  if (!token?.startsWith("sw.")) return false;
  const secret = getDashboardBridgeSecret();
  if (!secret) return false;
  const [, encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return false;
  const payload = Buffer.from(encodedPayload, "base64url").toString("utf-8");
  const a = Buffer.from(signature);
  const b = Buffer.from(signSwitchPayload(payload, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [tokenGuildId, issuedAtRaw] = payload.split(":");
  const issuedAt = Number(issuedAtRaw);
  return tokenGuildId === guildId && Number.isFinite(issuedAt) && Date.now() - issuedAt <= SWITCH_TOKEN_VALIDITY_MS;
}
