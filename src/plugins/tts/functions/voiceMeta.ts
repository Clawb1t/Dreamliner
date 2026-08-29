import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Display metadata for a voice, sidecar to Piper's own `<id>.onnx.json`. Written when a voice
 * is installed from the manifest; voices without a sidecar (dropped in manually) just don't get
 * expanded into per-speaker options (see piper.ts).
 */
export type VoiceMeta = {
  id: string;
  name: string;
  languageName: string;
  countryName: string;
  regionCode: string;
  quality: string;
  /** Ordered by speaker index. Present only for multi-speaker dataset models (e.g. VCTK). */
  speakers?: string[];
};

const cache = new Map<string, VoiceMeta | null>();

function metaPath(voicesDir: string, id: string): string {
  return path.join(voicesDir, `${id}.label.json`);
}

export async function writeVoiceMeta(voicesDir: string, meta: VoiceMeta): Promise<void> {
  await writeFile(metaPath(voicesDir, meta.id), JSON.stringify(meta), "utf8");
  cache.set(meta.id, meta);
}

export async function readVoiceMeta(voicesDir: string, id: string): Promise<VoiceMeta | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  try {
    const raw = await readFile(metaPath(voicesDir, id), "utf8");
    const meta = JSON.parse(raw) as VoiceMeta;
    cache.set(id, meta);
    return meta;
  } catch {
    cache.set(id, null);
    return null;
  }
}

export function capitalize(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value;
}

// A small pool of 3-word style tags, spread across a range of textures so voices read as
// distinct from each other in a list. These describe nothing we've actually heard — this repo
// has no way to play or analyze audio — they're browsing labels, assigned deterministically
// (same id always gets the same tag) rather than a verified acoustic description.
const DESCRIPTOR_POOL = [
  "soft, simple, warm",
  "bright, quick, clear",
  "calm, steady, low",
  "warm, rich, deep",
  "crisp, light, airy",
  "bold, strong, deep",
  "gentle, smooth, mellow",
  "clear, plain, even",
  "quick, sharp, bright",
  "deep, slow, rich",
  "light, airy, soft",
  "firm, direct, plain",
  "mellow, warm, easy",
  "cool, even, clear",
  "lively, bright, quick",
  "hushed, soft, gentle",
  "steady, calm, plain",
  "rich, full, warm",
  "light, quick, clear",
  "smooth, even, mellow",
] as const;

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 3-word style tag for a voice id — same id always gets the same tag. */
export function pickDescriptor(id: string): string {
  return DESCRIPTOR_POOL[hashString(`${id}#tag`) % DESCRIPTOR_POOL.length]!;
}
