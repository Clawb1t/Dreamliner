export const SUGGEST_PREFIX = "dl:suggest:";
export const SUGGEST_MODAL_ID = "dl:suggest:submit";
export const SUGGEST_ANON_MODAL_ID = "dl:suggest:submit:anon";

export type SuggestionStatus = "awaiting_review" | "approved" | "denied";
export type VoteValue = "up" | "mid" | "down";

export const DISPLAY_STATUS_LABELS: Record<string, string> = {
  none: "None",
  considered: "In consideration",
  progress: "In progress",
  implemented: "Implemented",
  no: "Not happening",
};

export function suggestQueueApproveId(id: number): string {
  return `${SUGGEST_PREFIX}qa:${id}`;
}

export function suggestQueueDenyId(id: number): string {
  return `${SUGGEST_PREFIX}qd:${id}`;
}

export function suggestVoteId(id: number, value: VoteValue): string {
  return `${SUGGEST_PREFIX}v:${value}:${id}`;
}

/** "View votes" on a suggestion post (page 1); pagination buttons append `:prev:N` / `:next:N`. */
export function suggestVotersId(id: number): string {
  return `${SUGGEST_PREFIX}vl:${id}`;
}

export function parseSuggestCustomId(
  customId: string,
):
  | { kind: "queue"; action: "approve" | "deny"; id: number }
  | { kind: "vote"; value: VoteValue; id: number }
  | { kind: "voters"; id: number; page: number }
  | null {
  if (!customId.startsWith(SUGGEST_PREFIX)) return null;
  const rest = customId.slice(SUGGEST_PREFIX.length);
  const queue = /^(qa|qd):(\d+)$/.exec(rest);
  if (queue) {
    return {
      kind: "queue",
      action: queue[1] === "qa" ? "approve" : "deny",
      id: Number(queue[2]),
    };
  }
  const voters = /^vl:(\d+)(?::(prev|next):(\d+))?$/.exec(rest);
  if (voters) {
    const from = Number(voters[3] ?? 1);
    const page = voters[2] === "prev" ? from - 1 : voters[2] === "next" ? from + 1 : 1;
    return { kind: "voters", id: Number(voters[1]), page: Math.max(1, page) };
  }
  const vote = /^v:(up|mid|down):(\d+)$/.exec(rest);
  if (vote) {
    return {
      kind: "vote",
      value: vote[1] as VoteValue,
      id: Number(vote[2]),
    };
  }
  return null;
}
