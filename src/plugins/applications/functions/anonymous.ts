import { createHmac } from "node:crypto";

/**
 * Anonymous form responses don't store the member's id. They store a keyed hash of it instead,
 * so "one response each", cooldowns and "erase my data" still work, but nobody reading the
 * responses (on the dashboard or in the database) can tell who sent one.
 *
 * Set FORMS_ANONYMOUS_SECRET once and never change it: a new secret can't match older anonymous
 * responses to their members any more (they'd still be counted, just no longer linked).
 */
const PREFIX = "anon:";

function secret(): string {
  return process.env.FORMS_ANONYMOUS_SECRET?.trim() || process.env.DASHBOARD_BRIDGE_SECRET?.trim() || "dreamliner-forms-anonymous";
}

export function anonymousKey(userId: string): string {
  return PREFIX + createHmac("sha256", secret()).update(`forms:${userId}`).digest("hex").slice(0, 40);
}

export function isAnonymousKey(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** The value stored in `user_id` for this member's response to this form. */
export function responderKey(userId: string, anonymous: boolean): string {
  return anonymous ? anonymousKey(userId) : userId;
}
