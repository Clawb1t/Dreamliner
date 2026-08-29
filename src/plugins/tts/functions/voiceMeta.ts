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
