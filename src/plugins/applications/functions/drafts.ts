import type { Attachment } from "discord.js";
import type { FormAnswer } from "../../../core/formModal.js";

/**
 * Answers from the pages of a multi-page application that have been submitted so far. Discord
 * can't open a modal straight from another modal's submit, so between pages the member clicks a
 * Continue button; their earlier pages wait here. Drafts live in memory only: a restart (or 30
 * idle minutes) just means starting the form again, which is fine for something this short-lived.
 */
export type ApplicationDraft = {
  answers: FormAnswer[];
  files: Attachment[];
  /** Pages completed so far (the next page to show). */
  pagesDone: number;
  expiresAt: number;
};

const DRAFT_TTL_MS = 30 * 60_000;
const drafts = new Map<string, ApplicationDraft>();

function key(guildId: string, userId: string, openingId: string): string {
  return `${guildId}:${userId}:${openingId}`;
}

function sweep(now: number): void {
  for (const [k, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(k);
}

export function getDraft(guildId: string, userId: string, openingId: string): ApplicationDraft | null {
  const now = Date.now();
  const draft = drafts.get(key(guildId, userId, openingId));
  if (!draft || draft.expiresAt <= now) return null;
  return draft;
}

export function saveDraft(guildId: string, userId: string, openingId: string, draft: Omit<ApplicationDraft, "expiresAt">): void {
  const now = Date.now();
  sweep(now);
  drafts.set(key(guildId, userId, openingId), { ...draft, expiresAt: now + DRAFT_TTL_MS });
}

export function clearDraft(guildId: string, userId: string, openingId: string): void {
  drafts.delete(key(guildId, userId, openingId));
}
