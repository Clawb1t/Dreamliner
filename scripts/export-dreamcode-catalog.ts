/**
 * Exports ACTION_DEFS to docs/dreamcode/actions.catalog.json for the website editor.
 * Run: npx tsx scripts/export-dreamcode-catalog.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_DEFS, actionsByCategory, DEFAULT_LIMITS } from "../src/dreamcode/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "../docs/dreamcode/actions.catalog.json");

const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  limits: DEFAULT_LIMITS,
  categories: Object.keys(actionsByCategory()).sort(),
  actions: ACTION_DEFS,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
console.log(`Wrote ${ACTION_DEFS.length} actions → ${outPath}`);
