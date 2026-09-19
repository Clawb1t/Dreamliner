import { isDreamlinerOneActive } from "../../bridge/dreamlinerOne.js";
import { consumeFreeAiUse } from "./usage.js";

export const AI_ONE_REQUIRED = "Autopilot's free uses are used up. Dreamliner One is required to keep using it.";

export type AiGateResult =
  | { ok: true; oneActive: boolean; freeUsesRemaining: number }
  | { ok: false; error: string; status: number; freeUsesRemaining: number };

/** Enforces the AI usage gate, consuming a free use if this guild isn't a Dreamliner One
 * subscriber. Call this BEFORE making an AI request so a blocked guild never triggers one. */
export async function consumeAiGate(guildId: string): Promise<AiGateResult> {
  if (await isDreamlinerOneActive(guildId)) {
    return { ok: true, oneActive: true, freeUsesRemaining: 1 };
  }

  if (await consumeFreeAiUse(guildId)) {
    return { ok: true, oneActive: false, freeUsesRemaining: 0 };
  }

  return { ok: false, error: AI_ONE_REQUIRED, status: 403, freeUsesRemaining: 0 };
}
