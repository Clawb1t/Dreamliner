/**
 * Scans src/**\/*.ts for every `t("key", "fallback")` / `ctx.t("key", "fallback")` call and
 * writes `i18n/locales/manifest.json`: a flat `"key" -> English fallback text` map covering
 * every translation key currently used anywhere in the bot.
 *
 * Two things read this manifest:
 *  - src/i18n/registry.ts's `createLanguage` — seeds a brand-new language's dictionary with
 *    every known key set to its English text, so a superuser creating a language from the
 *    dashboard starts from "everything in English" and edits from there, instead of an empty
 *    dictionary that silently falls back to English forever.
 *  - the dashboard's language dictionary editor, so it can show every translatable key (not
 *    just the ones a language happens to already have a row for).
 *
 * Best-effort: a plain string-literal fallback (`"..."`/'...') is captured exactly. A template
 * literal fallback (`` `...${x}...` ``) is captured as its literal source text — `${x}` included
 * verbatim, since the real value only exists at runtime — which is still useful context for a
 * translator/superuser filling in the dictionary, just not a perfect final string.
 *
 * Run with `npm run i18n:extract`. Safe to re-run any time (fully regenerates the file); existing
 * DB dictionary rows are never touched by this script.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "../src");
const OUT_PATH = join(__dirname, "../i18n/locales/manifest.json");

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules") continue;
      listTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Parses one string literal ("...", '...', or `...`) starting at `src[i]` (which must be a
 *  quote character). Returns the literal's raw source text (including delimiters) and the index
 *  just past it, or null if `src[i]` isn't a quote or the literal never closes. Handles `\`
 *  escapes and, for backticks, nested `${ ... }` (including nested strings/braces one level). */
function readStringLiteral(src: string, i: number): { raw: string; next: number } | null {
  const quote = src[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let j = i + 1;
  let depth = 0; // ${ ... } nesting inside a template literal
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && src[j + 1] === "{") {
      depth += 1;
      j += 2;
      continue;
    }
    if (quote === "`" && depth > 0) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      j += 1;
      continue;
    }
    if (ch === quote) {
      return { raw: src.slice(i, j + 1), next: j + 1 };
    }
    j += 1;
  }
  return null;
}

function literalValue(raw: string): string {
  // Strip the surrounding quote/backtick; leave escapes and ${...} as-is (best effort — see header).
  return raw.slice(1, -1);
}

const CALL_PATTERN = /(?<![\w$])t\(/g;

function extractFromFile(path: string, into: Map<string, string>): void {
  const src = readFileSync(path, "utf8");
  let match: RegExpExecArray | null;
  CALL_PATTERN.lastIndex = 0;
  while ((match = CALL_PATTERN.exec(src))) {
    let i = match.index + match[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
    const key = readStringLiteral(src, i);
    if (!key) continue;
    i = key.next;
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
    if (src[i] !== ",") continue;
    i += 1;
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
    const fallback = readStringLiteral(src, i);
    if (!fallback) continue;

    const keyValue = literalValue(key.raw);
    if (!/^[a-zA-Z0-9_.]+$/.test(keyValue)) continue; // skip false positives (dynamic keys etc.)
    if (!into.has(keyValue)) {
      into.set(keyValue, literalValue(fallback.raw));
    }
  }
}

function main(): void {
  const entries = new Map<string, string>();
  for (const file of listTsFiles(SRC_ROOT)) {
    extractFromFile(file, entries);
  }
  const sorted = Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(OUT_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  console.log(`Wrote ${entries.size} keys to ${OUT_PATH}`);
}

main();
