export const GIVEAWAY_ENTER_PREFIX = "dl:giveaway:enter:";
export const GIVEAWAY_CLAIM_PREFIX = "dl:giveaway:claim:";

export function buildGiveawayEnterCustomId(giveawayId: number): string {
  return `${GIVEAWAY_ENTER_PREFIX}${giveawayId}`;
}

export function parseGiveawayEnterCustomId(customId: string): { giveawayId: number } | null {
  if (!customId.startsWith(GIVEAWAY_ENTER_PREFIX)) return null;
  const giveawayId = Number(customId.slice(GIVEAWAY_ENTER_PREFIX.length));
  if (!Number.isFinite(giveawayId)) return null;
  return { giveawayId };
}

export function buildGiveawayClaimCustomId(giveawayId: number, winnerRowId: number): string {
  return `${GIVEAWAY_CLAIM_PREFIX}${giveawayId}:${winnerRowId}`;
}

export function parseGiveawayClaimCustomId(customId: string): { giveawayId: number; winnerRowId: number } | null {
  if (!customId.startsWith(GIVEAWAY_CLAIM_PREFIX)) return null;
  const rest = customId.slice(GIVEAWAY_CLAIM_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const giveawayId = Number(rest.slice(0, sep));
  const winnerRowId = Number(rest.slice(sep + 1));
  if (!Number.isFinite(giveawayId) || !Number.isFinite(winnerRowId)) return null;
  return { giveawayId, winnerRowId };
}
