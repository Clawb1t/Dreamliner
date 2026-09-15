import { getDb } from "../db/client.js";
import { botTranslations } from "../db/schema.js";
import { invalidateCatalogCache } from "./catalog.js";
import { readManifest } from "./manifest.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("i18n");

export type BulkTranslateStatus = {
  state: "idle" | "running" | "done" | "error";
  total: number;
  completed: number;
  failed: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

const statuses = new Map<string, BulkTranslateStatus>();
const CONCURRENCY = 5;
/** Small stagger between requests within each worker lane so the free endpoint doesn't see a
 *  burst — google-translate-api-x hits translate.googleapis.com with no API key. */
const REQUEST_DELAY_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getBulkTranslateStatus(locale: string): BulkTranslateStatus {
  return statuses.get(locale) ?? { state: "idle", total: 0, completed: 0, failed: 0 };
}

/**
 * Kicks off (or reports on) a background job that machine-translates every manifest key's
 * English text into `locale` via Google Translate's free endpoint, overwriting that language's
 * entire dictionary. Returns immediately; poll {@link getBulkTranslateStatus} for progress. A
 * second call while one is already running for that locale just returns the current status
 * rather than starting a duplicate job.
 */
export function startBulkTranslate(locale: string): BulkTranslateStatus {
  const existing = statuses.get(locale);
  if (existing?.state === "running") return existing;

  const manifest = Object.entries(readManifest());
  const status: BulkTranslateStatus = {
    state: "running",
    total: manifest.length,
    completed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
  };
  statuses.set(locale, status);

  void runBulkTranslate(locale, manifest, status).catch((error) => {
    status.state = "error";
    status.error = error instanceof Error ? error.message : String(error);
    status.finishedAt = new Date().toISOString();
    log.error(`[i18n] Bulk translate for "${locale}" failed:`, error);
  });

  return status;
}

/** Matches everything that must survive machine translation byte-for-byte: a `{varName}`
 *  placeholder, a literal backtick (Discord code-span markdown, e.g. `` `{count}` `` — left
 *  alone, Google Translate tends to swap straight backticks/quotes for locale-specific curly
 *  quote characters, e.g. „79") , or a real newline (multi-line fields like the edits/deletes/
 *  reactions/attachments summary — translating the whole blob as one string is fine, but a
 *  newline getting reflowed or dropped isn't). */
const GUARDED_PATTERN = /\{(\w+)\}|`|\n/g;
/** Meaningless token (not a real word in any language, so Google Translate has nothing to
 *  translate) standing in for each guarded piece while the surrounding text gets translated. */
const guardToken = (index: number) => `qxkz${index}qxkz`;
const GUARD_PATTERN = /qxkz\s*(\d+)\s*qxkz/gi;

type GuardedPiece = { varName: string } | "backtick" | "newline";

/** Swaps every placeholder/backtick/newline for a guard token so machine translation can't
 *  mangle them, then swaps the guard tokens back to the original text afterward — translators
 *  regularly reorder/adjust spacing around words but leave a meaningless alphanumeric token
 *  alone, which real punctuation/whitespace doesn't survive nearly as well. */
function guardText(text: string): { guarded: string; pieces: GuardedPiece[] } {
  const pieces: GuardedPiece[] = [];
  const guarded = text.replace(GUARDED_PATTERN, (match, name: string | undefined) => {
    const token = guardToken(pieces.length);
    pieces.push(name !== undefined ? { varName: name } : match === "`" ? "backtick" : "newline");
    return token;
  });
  return { guarded, pieces };
}

function restoreGuardedText(text: string, pieces: GuardedPiece[]): string {
  return text.replace(GUARD_PATTERN, (match, indexRaw: string) => {
    const piece = pieces[Number(indexRaw)];
    if (piece === undefined) return match;
    if (piece === "backtick") return "`";
    if (piece === "newline") return "\n";
    return `{${piece.varName}}`;
  });
}

async function translateOne(locale: string, englishText: string): Promise<string | null> {
  const trimmed = englishText.trim();
  if (!trimmed) return "";
  const { guarded, pieces } = guardText(trimmed);
  try {
    const { translateText } = await import("../plugins/translation/functions/translate.js");
    const result = await translateText(guarded, locale, "en");
    return pieces.length ? restoreGuardedText(result.text, pieces) : result.text;
  } catch (error) {
    log.warn(`[i18n] Machine translation failed for "${locale}":`, error);
    return null;
  }
}

async function runBulkTranslate(
  locale: string,
  manifest: [string, string][],
  status: BulkTranslateStatus,
): Promise<void> {
  const db = getDb();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= manifest.length) return;
      const [key, englishText] = manifest[index]!;

      const translated = await translateOne(locale, englishText);
      if (translated !== null) {
        await db
          .insert(botTranslations)
          .values({ locale, key, value: translated, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [botTranslations.locale, botTranslations.key],
            set: { value: translated, updatedAt: new Date() },
          });
        status.completed += 1;
      } else {
        status.failed += 1;
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker()));

  invalidateCatalogCache(locale);
  status.state = "done";
  status.finishedAt = new Date().toISOString();
}
