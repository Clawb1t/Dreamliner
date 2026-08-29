import { readFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile, fileExists } from "./piperSetup.js";
import { writeVoiceMeta } from "./voiceMeta.js";

/**
 * Bulk-installs every distinct Piper voice (in the requested languages) from the community
 * voices repo (https://huggingface.co/rhasspy/piper-voices), so `/tts voice` has a real
 * catalogue to pick from instead of just the one auto-installed default. Reads the repo's own
 * manifest for accurate file paths rather than guessing voice ids.
 */

const MANIFEST_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json";
const MANIFEST_TIMEOUT_MS = 60_000;
const VOICES_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

// Retries + a short pause between voices: on a slow/shared host connection, a single failed
// attempt (timeout, transient network blip) shouldn't permanently exclude a voice, and spacing
// requests out a little is gentler on the CDN than hammering it back-to-back.
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;
const BETWEEN_VOICES_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetries(url: string, destPath: string, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      await downloadFile(url, destPath);
      return;
    } catch (error) {
      lastError = error;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[tts] Attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed for ${label}: ${reason}`);
      if (attempt < DOWNLOAD_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type VoiceManifestEntry = {
  key: string;
  name: string;
  language: { code: string; family: string; region: string; name_english: string; country_english: string };
  quality: string;
  num_speakers: number;
  speaker_id_map: Record<string, number>;
  files: Record<string, unknown>;
};

type VoiceManifest = Record<string, VoiceManifestEntry>;

async function fetchVoiceManifest(): Promise<VoiceManifest> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Could not fetch Piper voice manifest (${res.status}).`);
      return (await res.json()) as VoiceManifest;
    } catch (error) {
      lastError = error;
      console.warn(
        `[tts] Manifest fetch attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < DOWNLOAD_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Prefer the community's recommended sweet spot (medium) and fall back to whatever else
// exists for a given voice name, rather than installing every quality tier of every voice.
const QUALITY_PREFERENCE = ["medium", "high", "low", "x_low"];

function pickOneEntryPerVoice(manifest: VoiceManifest, families: string[]): VoiceManifestEntry[] {
  const best = new Map<string, VoiceManifestEntry>();
  for (const entry of Object.values(manifest)) {
    if (!families.includes(entry.language.family)) continue;
    const groupKey = `${entry.language.code}-${entry.name}`;
    const existing = best.get(groupKey);
    if (!existing || QUALITY_PREFERENCE.indexOf(entry.quality) < QUALITY_PREFERENCE.indexOf(existing.quality)) {
      best.set(groupKey, entry);
    }
  }
  return [...best.values()];
}

// Multi-speaker models above this size (LibriTTS's ~904-speaker sets) aren't expanded into
// individual voices — that many autocomplete entries from anonymized narrator ids isn't a
// usable picker. Smaller sets (VCTK's 109, ARCTIC's 18, etc.) are genuinely browsable.
const MAX_EXPANDED_SPEAKERS = 150;

/** Ordered speaker names by index, or undefined for a single-speaker voice / a set too large to expand. */
function speakerNamesFor(voice: VoiceManifestEntry): string[] | undefined {
  if (voice.num_speakers <= 1 || voice.num_speakers > MAX_EXPANDED_SPEAKERS) return undefined;
  const entries = Object.entries(voice.speaker_id_map ?? {});
  if (entries.length === voice.num_speakers) {
    return entries.sort((a, b) => a[1] - b[1]).map(([name]) => name);
  }
  // No named speaker map — fall back to plain numbered speakers.
  return Array.from({ length: voice.num_speakers }, (_, i) => `speaker ${i}`);
}

/** True only if the file exists AND parses as JSON — a partial/corrupt download shouldn't count as installed. */
async function onnxConfigIsValid(jsonPath: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(jsonPath, "utf8"));
    return true;
  } catch {
    return false;
  }
}

export type BulkInstallResult = { installed: string[]; skipped: number; failed: { voice: string; reason: string }[] };

/**
 * Idempotent — only (re-)downloads voices that aren't already present *and valid* in
 * `voicesDir`. A voice whose `.onnx` exists but whose `.onnx.json` is missing or corrupt (e.g.
 * an interrupted download from before atomic writes were added) gets re-downloaded rather than
 * silently skipped forever.
 */
export async function ensureVoicePackInstalled(voicesDir: string, families: string[]): Promise<BulkInstallResult> {
  const manifest = await fetchVoiceManifest();
  const voices = pickOneEntryPerVoice(manifest, families);

  const installed: string[] = [];
  const failed: { voice: string; reason: string }[] = [];
  let skipped = 0;

  for (const voice of voices) {
    const onnxPath = path.join(voicesDir, `${voice.key}.onnx`);
    const jsonPath = path.join(voicesDir, `${voice.key}.onnx.json`);
    if ((await fileExists(onnxPath)) && (await onnxConfigIsValid(jsonPath))) {
      skipped++;
      continue;
    }

    const onnxRel = Object.keys(voice.files).find((f) => f.endsWith(".onnx"));
    const jsonRel = Object.keys(voice.files).find((f) => f.endsWith(".onnx.json"));
    if (!onnxRel || !jsonRel) {
      failed.push({ voice: voice.key, reason: "Manifest entry is missing .onnx/.onnx.json file paths." });
      continue;
    }

    try {
      await downloadWithRetries(`${VOICES_BASE_URL}/${onnxRel}`, onnxPath, `${voice.key} (.onnx)`);
      await downloadWithRetries(`${VOICES_BASE_URL}/${jsonRel}`, jsonPath, `${voice.key} (.onnx.json)`);
      await writeVoiceMeta(voicesDir, {
        id: voice.key,
        name: voice.name,
        languageName: voice.language.name_english,
        countryName: voice.language.country_english,
        regionCode: voice.language.region,
        quality: voice.quality,
        speakers: speakerNamesFor(voice),
      });
      installed.push(voice.key);
      console.log(`[tts] Installed voice ${installed.length}/${voices.length - skipped}: ${voice.key}`);
    } catch (error) {
      failed.push({ voice: voice.key, reason: error instanceof Error ? error.message : String(error) });
      console.warn(`[tts] Giving up on ${voice.key} after ${DOWNLOAD_ATTEMPTS} attempts.`);
    }

    await sleep(BETWEEN_VOICES_DELAY_MS);
  }

  return { installed, skipped, failed };
}
