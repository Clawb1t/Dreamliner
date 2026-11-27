/**
 * Custom-ID prefix for every Forms component (Forms grew out of Applications, so the prefix and
 * every id format from before Forms are unchanged: buttons on older posts keep working).
 */
export const APPLICATION_PREFIX = "dl:app:";

/** The apply button on an opening's post. */
export function applicationApplyId(openingId: string): string {
  return `${APPLICATION_PREFIX}apply:${openingId}`;
}

/** "Continue" button shown between pages of a multi-page form (0-indexed page to open next). */
export function applicationContinueId(openingId: string, page: number): string {
  return `${APPLICATION_PREFIX}next:${openingId}:${page}`;
}

/** One page of the application form (0-indexed). */
export function applicationModalId(openingId: string, page: number): string {
  return `${APPLICATION_PREFIX}modal:${openingId}:${page}`;
}

export function applicationAcceptId(applicationId: number): string {
  return `${APPLICATION_PREFIX}accept:${applicationId}`;
}

export function applicationDenyId(applicationId: number): string {
  return `${APPLICATION_PREFIX}deny:${applicationId}`;
}

/** Optional-reason modal shown when a reviewer clicks Deny. */
export function applicationDenyModalId(applicationId: number): string {
  return `${APPLICATION_PREFIX}denymodal:${applicationId}`;
}

export const APPLICATION_REASON_FIELD_ID = `${APPLICATION_PREFIX}reason`;

/** Modal field custom ID for the Nth (0-indexed) question on the current page. */
export function applicationFieldId(index: number): string {
  return `${APPLICATION_PREFIX}q:${index}`;
}

export type RsvpButtonChoice = "going" | "maybe" | "not_going";

/** RSVP buttons on an event's post. */
export function formRsvpId(openingId: string, choice: RsvpButtonChoice): string {
  return `${APPLICATION_PREFIX}rsvp:${openingId}:${choice}`;
}

/** "Fix answers": reopens a page that didn't pass validation, with the answers filled back in. */
export function formRetryId(openingId: string, page: number): string {
  return `${APPLICATION_PREFIX}retry:${openingId}:${page}`;
}

/** "Who's going" on an RSVP post. */
export function formAttendeesId(openingId: string): string {
  return `${APPLICATION_PREFIX}who:${openingId}`;
}

/** The status menu on a response posted for custom review. */
export function formStatusSelectId(applicationId: number): string {
  return `${APPLICATION_PREFIX}status:${applicationId}`;
}

export type ParsedApplicationCustomId =
  | { kind: "apply"; openingId: string }
  | { kind: "next"; openingId: string; page: number }
  | { kind: "modal"; openingId: string; page: number }
  | { kind: "accept"; applicationId: number }
  | { kind: "deny"; applicationId: number }
  | { kind: "denymodal"; applicationId: number }
  | { kind: "rsvp"; openingId: string; choice: RsvpButtonChoice }
  | { kind: "retry"; openingId: string; page: number }
  | { kind: "who"; openingId: string }
  | { kind: "status"; applicationId: number };

const UUID = "[0-9a-fA-F-]{36}";

export function parseApplicationCustomId(customId: string): ParsedApplicationCustomId | null {
  if (!customId.startsWith(APPLICATION_PREFIX)) return null;
  const rest = customId.slice(APPLICATION_PREFIX.length);

  let match = new RegExp(`^(apply|who):(${UUID})$`).exec(rest);
  if (match) return { kind: match[1] as "apply" | "who", openingId: match[2]! };

  match = new RegExp(`^(next|modal|retry):(${UUID}):(\\d+)$`).exec(rest);
  if (match) return { kind: match[1] as "next" | "modal" | "retry", openingId: match[2]!, page: Number(match[3]) };

  match = new RegExp(`^rsvp:(${UUID}):(going|maybe|not_going)$`).exec(rest);
  if (match) return { kind: "rsvp", openingId: match[1]!, choice: match[2] as RsvpButtonChoice };

  match = /^(accept|deny|denymodal|status):(\d+)$/.exec(rest);
  if (match) return { kind: match[1] as "accept" | "deny" | "denymodal" | "status", applicationId: Number(match[2]) };

  return null;
}
