/** Custom-ID prefix for every Applications component, mirroring tickets/constants.ts. */
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

export type ParsedApplicationCustomId =
  | { kind: "apply"; openingId: string }
  | { kind: "next"; openingId: string; page: number }
  | { kind: "modal"; openingId: string; page: number }
  | { kind: "accept"; applicationId: number }
  | { kind: "deny"; applicationId: number }
  | { kind: "denymodal"; applicationId: number };

const UUID = "[0-9a-fA-F-]{36}";

export function parseApplicationCustomId(customId: string): ParsedApplicationCustomId | null {
  if (!customId.startsWith(APPLICATION_PREFIX)) return null;
  const rest = customId.slice(APPLICATION_PREFIX.length);

  let match = new RegExp(`^apply:(${UUID})$`).exec(rest);
  if (match) return { kind: "apply", openingId: match[1]! };

  match = new RegExp(`^(next|modal):(${UUID}):(\\d+)$`).exec(rest);
  if (match) return { kind: match[1] as "next" | "modal", openingId: match[2]!, page: Number(match[3]) };

  match = /^(accept|deny|denymodal):(\d+)$/.exec(rest);
  if (match) return { kind: match[1] as "accept" | "deny" | "denymodal", applicationId: Number(match[2]) };

  return null;
}
