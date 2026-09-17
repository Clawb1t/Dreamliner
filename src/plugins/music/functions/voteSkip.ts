type VoteState = {
  trackEncoded: string | undefined;
  voterIds: Set<string>;
  timeout: NodeJS.Timeout;
};

const votes = new Map<string, VoteState>();

function clear(guildId: string): void {
  const state = votes.get(guildId);
  if (state) clearTimeout(state.timeout);
  votes.delete(guildId);
}

export type VoteSkipResult =
  | { status: "skipped" }
  | { status: "registered"; have: number; need: number }
  | { status: "already_voted"; have: number; need: number };

/** Registers `voterId`'s vote to skip `trackEncoded` in `guildId`. A vote for a different track
 *  than the one currently tracked (new track since the last vote) starts a fresh tally. */
export function registerVote(
  guildId: string,
  trackEncoded: string | undefined,
  voterId: string,
  need: number,
  timeoutMs: number,
): VoteSkipResult {
  let state = votes.get(guildId);
  if (!state || state.trackEncoded !== trackEncoded) {
    if (state) clearTimeout(state.timeout);
    state = {
      trackEncoded,
      voterIds: new Set(),
      timeout: setTimeout(() => clear(guildId), timeoutMs),
    };
    votes.set(guildId, state);
  }

  if (state.voterIds.has(voterId)) {
    return { status: "already_voted", have: state.voterIds.size, need };
  }

  state.voterIds.add(voterId);
  if (state.voterIds.size >= need) {
    clear(guildId);
    return { status: "skipped" };
  }
  return { status: "registered", have: state.voterIds.size, need };
}

export function clearVotes(guildId: string): void {
  clear(guildId);
}

export function requiredVotes(nonBotMembersInChannel: number, thresholdPercent: number): number {
  return Math.max(1, Math.ceil(nonBotMembersInChannel * (thresholdPercent / 100)));
}
