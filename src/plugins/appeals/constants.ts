/** Custom-ID prefix for every Appeals component, mirroring applications/constants.ts. */
export const APPEAL_PREFIX = "dl:appeal:";

export type AppealAction = "approve" | "deny" | "info";

/** Review-message buttons. */
export function appealButtonId(action: AppealAction, appealId: number): string {
  return `${APPEAL_PREFIX}${action}:${appealId}`;
}

/** The modal each review button opens (approve note, deny reason, info question). */
export function appealModalId(action: AppealAction, appealId: number): string {
  return `${APPEAL_PREFIX}modal:${action}:${appealId}`;
}

export const APPEAL_TEXT_FIELD_ID = `${APPEAL_PREFIX}text`;
export const APPEAL_REVERSE_FIELD_ID = `${APPEAL_PREFIX}reverse`;

export type ParsedAppealCustomId =
  | { kind: "button"; action: AppealAction; appealId: number }
  | { kind: "modal"; action: AppealAction; appealId: number };

export function parseAppealCustomId(customId: string): ParsedAppealCustomId | null {
  if (!customId.startsWith(APPEAL_PREFIX)) return null;
  const rest = customId.slice(APPEAL_PREFIX.length);
  let match = /^(approve|deny|info):(\d+)$/.exec(rest);
  if (match) return { kind: "button", action: match[1] as AppealAction, appealId: Number(match[2]) };
  match = /^modal:(approve|deny|info):(\d+)$/.exec(rest);
  if (match) return { kind: "modal", action: match[1] as AppealAction, appealId: Number(match[2]) };
  return null;
}
