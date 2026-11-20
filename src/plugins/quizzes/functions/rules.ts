/**
 * Who may start a quiz right now: status and open/close window, required/blocked roles, attempts
 * limit and cooldown. Pure, unit-tested in quizzes.test.ts.
 */
import type { Quiz } from "./types.js";

export type EligibilityInput = {
  quiz: Pick<Quiz, "status" | "opensAt" | "closesAt" | "settings">;
  now: number;
  memberRoleIds: string[];
  /** Finished attempts (completed or expired) by this member on this quiz. */
  finishedAttempts: number;
  lastFinishedAt: number | null;
  /** An unfinished attempt exists: resuming it is always allowed while the quiz is open. */
  hasOpenAttempt: boolean;
};

export type Eligibility = { ok: true; attemptsLeft: number | null } | { ok: false; reason: string; retryAt?: number };

function ts(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/** Whether the quiz is taking answers at `now` (published and inside its window). */
export function quizIsOpen(quiz: Pick<Quiz, "status" | "opensAt" | "closesAt">, now: number): boolean {
  if (quiz.status !== "published") return false;
  if (quiz.opensAt && quiz.opensAt.getTime() > now) return false;
  if (quiz.closesAt && quiz.closesAt.getTime() <= now) return false;
  return true;
}

export function checkEligibility(input: EligibilityInput): Eligibility {
  const { quiz, now, settings } = { ...input, settings: input.quiz.settings };
  if (quiz.status === "draft") return { ok: false, reason: "This quiz isn't published yet." };
  if (quiz.status === "archived") return { ok: false, reason: "This quiz has been archived." };
  if (quiz.status === "closed") return { ok: false, reason: "This quiz is closed." };
  if (quiz.opensAt && quiz.opensAt.getTime() > now) return { ok: false, reason: `This quiz opens ${ts(quiz.opensAt.getTime())}.`, retryAt: quiz.opensAt.getTime() };
  if (quiz.closesAt && quiz.closesAt.getTime() <= now) return { ok: false, reason: "This quiz has closed." };

  const roles = new Set(input.memberRoleIds);
  if (settings.blockedRoleIds.some((id) => roles.has(id))) return { ok: false, reason: "One of your roles can't take this quiz." };
  if (settings.requiredRoleIds.length && !settings.requiredRoleIds.some((id) => roles.has(id))) {
    return {
      ok: false,
      reason: `You need ${settings.requiredRoleIds.length === 1 ? "the" : "one of these roles:"} ${settings.requiredRoleIds.map((id) => `<@&${id}>`).join(", ")}${settings.requiredRoleIds.length === 1 ? " role" : ""} to take this quiz.`,
    };
  }

  if (input.hasOpenAttempt) {
    return { ok: true, attemptsLeft: settings.maxAttempts > 0 ? Math.max(0, settings.maxAttempts - input.finishedAttempts) : null };
  }

  if (settings.maxAttempts > 0 && input.finishedAttempts >= settings.maxAttempts) {
    return { ok: false, reason: settings.maxAttempts === 1 ? "You've already taken this quiz." : `You've used all ${settings.maxAttempts} attempts.` };
  }
  if (settings.cooldownMinutes > 0 && input.lastFinishedAt !== null) {
    const retryAt = input.lastFinishedAt + settings.cooldownMinutes * 60_000;
    if (retryAt > now) return { ok: false, reason: `You can try again ${ts(retryAt)}.`, retryAt };
  }
  return { ok: true, attemptsLeft: settings.maxAttempts > 0 ? settings.maxAttempts - input.finishedAttempts : null };
}
