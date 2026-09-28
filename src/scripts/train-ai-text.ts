/**
 * Trains Automod's AI-written text detector and regenerates
 * src/plugins/automod/functions/detectors/aiText/model.ts.
 *
 *   npx tsx src/scripts/train-ai-text.ts <corpus.jsonl> [more.jsonl ...]
 *
 * Each corpus line is `{"text": "...", "label": 0 | 1}` (1 = AI-written). Corpora are not kept in
 * the repo; only the fitted weights are. Texts are cropped at sentence boundaries to chat-sized
 * pieces (30 to 250 words) so the model learns from message-length text, then split 80/20 by a
 * hash of the text so the held-out report never sees a training sample.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractFeatures, FEATURE_NAMES, FEATURE_SIGNS, prepareText } from "../plugins/automod/functions/detectors/aiText/features.js";
import { AI_TEXT_MIN_WORDS } from "../plugins/automod/functions/detectors/aiText/score.js";

type Sample = { text: string; label: 0 | 1; source?: string };
type Row = { x: number[]; y: 0 | 1; words: number; test: boolean; source: string };

const MODEL_PATH = fileURLToPath(new URL("../plugins/automod/functions/detectors/aiText/model.ts", import.meta.url));

let seed = 1337;
function random(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

function crops(text: string): string[] {
  const sentences = text.replace(/\r/g, "").split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  const pieces = 2;
  for (let n = 0; n < pieces; n++) {
    const target = 30 + Math.floor(random() * 220);
    const start = Math.floor(random() * Math.max(1, sentences.length / 2));
    let piece = "";
    for (let i = start; i < sentences.length; i++) {
      piece += (piece ? " " : "") + sentences[i];
      if (piece.split(/\s+/).length >= target) break;
    }
    if (piece) out.push(piece);
  }
  return out;
}

function loadCorpus(paths: string[]): Sample[] {
  const samples: Sample[] = [];
  for (const path of paths) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Sample;
      if (typeof row.text === "string" && (row.label === 0 || row.label === 1)) samples.push(row);
    }
  }
  return samples;
}

function buildRows(samples: Sample[]): Row[] {
  const rows: Row[] = [];
  for (const sample of samples) {
    const test = createHash("sha1").update(sample.text).digest()[0]! < 52; // about 20%
    for (const piece of crops(sample.text)) {
      const prepared = prepareText(piece);
      if (prepared.words.length < AI_TEXT_MIN_WORDS) continue;
      const features = extractFeatures(prepared);
      rows.push({ x: FEATURE_NAMES.map((name) => features[name]), y: sample.label, words: prepared.words.length, test, source: (sample.source ?? "unknown").split("/")[0]! });
    }
  }
  return rows;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function reliability(words: number): number {
  return Math.min(1, 0.45 + words / 120);
}

function train(rows: Row[]) {
  const dims = FEATURE_NAMES.length;
  const means = Array.from({ length: dims }, (_, i) => rows.reduce((a, r) => a + r.x[i]!, 0) / rows.length);
  const stds = Array.from({ length: dims }, (_, i) => {
    const v = rows.reduce((a, r) => a + (r.x[i]! - means[i]!) ** 2, 0) / rows.length;
    return Math.sqrt(v) || 1;
  });
  const z = rows.map((r) => r.x.map((v, i) => (v - means[i]!) / stds[i]!));

  const positives = rows.filter((r) => r.y === 1).length;
  const negatives = rows.length - positives;
  const classWeight = { 1: rows.length / (2 * positives), 0: rows.length / (2 * negatives) };

  const weights = new Array<number>(dims).fill(0);
  let bias = 0;
  const lambda = 0.02;
  const rate = 0.3;
  for (let epoch = 0; epoch < 1500; epoch++) {
    const grad = new Array<number>(dims).fill(0);
    let gradBias = 0;
    rows.forEach((row, n) => {
      const zi = z[n]!;
      let logit = bias;
      for (let i = 0; i < dims; i++) logit += weights[i]! * zi[i]!;
      const err = (sigmoid(logit) - row.y) * classWeight[row.y];
      for (let i = 0; i < dims; i++) grad[i]! += err * zi[i]!;
      gradBias += err;
    });
    for (let i = 0; i < dims; i++) {
      weights[i]! -= rate * (grad[i]! / rows.length + lambda * weights[i]!);
      // Projected step: keep sign-constrained features on their allowed side of zero.
      const sign = FEATURE_SIGNS[FEATURE_NAMES[i]!];
      if (sign && weights[i]! * sign < 0) weights[i] = 0;
    }
    bias -= rate * (gradBias / rows.length);
  }
  return { means, stds, weights, bias };
}

function scoreRow(row: Row, model: ReturnType<typeof train>): number {
  let logit = model.bias;
  row.x.forEach((v, i) => {
    logit += model.weights[i]! * ((v - model.means[i]!) / model.stds[i]!);
  });
  return sigmoid(logit * reliability(row.words)) * 100;
}

function auc(scores: { s: number; y: 0 | 1 }[]): number {
  const sorted = [...scores].sort((a, b) => a.s - b.s);
  let rankSum = 0;
  sorted.forEach((item, i) => {
    if (item.y === 1) rankSum += i + 1;
  });
  const pos = sorted.filter((s) => s.y === 1).length;
  const neg = sorted.length - pos;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function report(label: string, rows: Row[], model: ReturnType<typeof train>) {
  const scored = rows.map((r) => ({ s: scoreRow(r, model), y: r.y }));
  const humans = scored.filter((s) => s.y === 0);
  const ais = scored.filter((s) => s.y === 1);
  console.log(`\n${label}: ${humans.length} human, ${ais.length} AI, AUC ${auc(scored).toFixed(3)}`);
  for (const threshold of [50, 70, 80, 90, 95]) {
    const fp = humans.filter((s) => s.s >= threshold).length / Math.max(1, humans.length);
    const tp = ais.filter((s) => s.s >= threshold).length / Math.max(1, ais.length);
    console.log(`  score >= ${threshold}: catches ${(tp * 100).toFixed(1)}% of AI, flags ${(fp * 100).toFixed(2)}% of humans`);
  }
  for (const source of [...new Set(rows.map((r) => r.source))]) {
    const subset = rows.filter((r) => r.source === source);
    const hits = subset.filter((r) => scoreRow(r, model) >= 85).length;
    console.log(`  ${source}: ${((hits / subset.length) * 100).toFixed(1)}% scored 85+ (${subset.length} texts)`);
  }
}

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error("Usage: npx tsx src/scripts/train-ai-text.ts <corpus.jsonl> [more.jsonl ...]");
  process.exit(1);
}

const samples = loadCorpus(paths);
const rows = buildRows(samples);
const trainRows = rows.filter((r) => !r.test);
const testRows = rows.filter((r) => r.test);
const model = train(trainRows);

report("Train", trainRows, model);
report("Held out", testRows, model);
console.log("\nWeights (standardized):");
FEATURE_NAMES.map((name, i) => [name, model.weights[i]!] as const)
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .forEach(([name, w]) => console.log(`  ${name.padEnd(20)} ${w >= 0 ? "+" : ""}${w.toFixed(3)}`));

const round = (values: number[]) => values.map((v) => Number(v.toFixed(5)));
writeFileSync(
  MODEL_PATH,
  `// Generated by src/scripts/train-ai-text.ts. Do not edit by hand; retrain instead.
// Feature order matches FEATURE_NAMES in ./features.ts.
export const AI_TEXT_MODEL = {
  trainedAt: ${JSON.stringify(new Date().toISOString().slice(0, 10))},
  samples: ${trainRows.length},
  means: ${JSON.stringify(round(model.means))},
  stds: ${JSON.stringify(round(model.stds))},
  weights: ${JSON.stringify(round(model.weights))},
  bias: ${Number(model.bias.toFixed(5))},
};
`,
);
console.log(`\nWrote ${MODEL_PATH}`);
