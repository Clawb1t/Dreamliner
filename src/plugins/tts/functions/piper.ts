import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { resolvePiperBin, resolvePiperVoicesDir } from "./piperSetup.js";
import { capitalize, readVoiceMeta } from "./voiceMeta.js";

/**
 * Local Piper TTS backend (https://github.com/rhasspy/piper). `piperSetup.ts` installs the
 * binary and a default voice automatically on boot if they're missing; this module just runs
 * it. Voice models are `<id>.onnx` + `<id>.onnx.json` pairs in the voices directory — add more
 * by dropping in more pairs, no code changes needed.
 */

function voicesDir(): string {
  return resolvePiperVoicesDir();
}

function piperBin(): string {
  return resolvePiperBin();
}

function safeVoiceId(voiceId: string): string | null {
  // Voice ids are filenames; reject anything that could escape PIPER_VOICES_DIR.
  if (!voiceId || voiceId.includes("/") || voiceId.includes("\\") || voiceId.includes("..")) return null;
  return voiceId;
}

export type PiperVoiceMeta = { id: string; sampleRate: number };

const metaCache = new Map<string, PiperVoiceMeta>();

/** Lists available voice ids (onnx filename stems) in PIPER_VOICES_DIR. Empty if unconfigured. */
export async function listPiperVoices(): Promise<string[]> {
  const dir = voicesDir();
  if (!dir) return [];
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".onnx"))
      .map((f) => f.slice(0, -".onnx".length))
      .sort();
  } catch {
    return [];
  }
}

export type PiperVoiceOption = { id: string; label: string; regionCode: string };

/**
 * Same voices as listPiperVoices(), paired with a display label built from Piper's own voice
 * name, e.g. "Amy" or "Aru 3" for a speaker pulled out of a multi-speaker model. The name itself
 * is always Piper's real name, never invented, so it can't misdescribe who a voice actually is —
 * but the per-speaker suffix is a plain sequential number rather than the model's raw speaker id
 * (VCTK's "p225", Aru's "03"), since those codes read as noise, not something a human picking a
 * voice can tell apart at a glance. `regionCode` is a plain ISO region code (e.g. "US", "JP") for
 * callers that want to render a flag; empty when unknown.
 *
 * A voice whose `.onnx.json` doesn't actually load (missing, or corrupt from an interrupted
 * download) is left out entirely rather than listed as pickable and then failing at synth time.
 */
export async function listPiperVoiceOptions(): Promise<PiperVoiceOption[]> {
  const ids = await listPiperVoices();
  const dir = voicesDir();

  const options: PiperVoiceOption[] = [];
  for (const id of ids) {
    if (!(await loadVoiceMeta(id))) continue;

    const meta = await readVoiceMeta(dir, id);
    const regionCode = meta?.regionCode ?? "";
    if (meta?.speakers?.length) {
      meta.speakers.forEach((_speakerLabel, index) => {
        const optionId = `${id}#${index}`;
        options.push({ id: optionId, label: `${capitalize(meta.name)} ${index + 1}`, regionCode });
      });
    } else {
      const name = meta?.name ?? id.split("-")[1] ?? id;
      options.push({ id, label: capitalize(name), regionCode });
    }
  }
  return options;
}

async function loadVoiceMeta(voiceId: string): Promise<PiperVoiceMeta | null> {
  const cached = metaCache.get(voiceId);
  if (cached) return cached;

  const dir = voicesDir();
  if (!dir) return null;

  try {
    const raw = await readFile(path.join(dir, `${voiceId}.onnx.json`), "utf8");
    const parsed = JSON.parse(raw) as { audio?: { sample_rate?: number } };
    const meta: PiperVoiceMeta = { id: voiceId, sampleRate: parsed.audio?.sample_rate ?? 22050 };
    metaCache.set(voiceId, meta);
    return meta;
  } catch {
    return null;
  }
}

export type PiperResult = { pcm: Buffer; sampleRate: number } | { error: string };

/** Runs `piper` for one line of text, returning raw signed-16-bit little-endian mono PCM. */
export async function synthesizeWithPiper(text: string, voiceId: string): Promise<PiperResult> {
  const dir = voicesDir();

  // Multi-speaker voices are exposed as `<model-id>#<speaker-index>`.
  const [rawModelId, speakerPart] = voiceId.split("#");
  const speakerIndex = speakerPart !== undefined ? Number(speakerPart) : undefined;
  if (speakerPart !== undefined && (!Number.isInteger(speakerIndex) || speakerIndex! < 0)) {
    return { error: `Invalid Piper voice "${voiceId}".` };
  }

  const safeId = safeVoiceId(rawModelId);
  if (!safeId) {
    return { error: `Invalid Piper voice "${voiceId}".` };
  }

  const meta = await loadVoiceMeta(safeId);
  if (!meta) {
    return {
      error: `Unknown Piper voice "${voiceId}" in ${dir}. If the bot just restarted, initial setup may still be downloading it — otherwise add <id>.onnx/<id>.onnx.json there manually.`,
    };
  }

  const modelPath = path.join(dir, `${safeId}.onnx`);
  const args = ["--model", modelPath, "--output_raw", "--quiet"];
  if (speakerIndex !== undefined) args.push("--speaker", String(speakerIndex));

  return new Promise((resolve) => {
    const proc = spawn(piperBin(), args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const finish = (result: PiperResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      finish({ error: `Could not start Piper ("${piperBin()}"): ${error.message}` });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        finish({ error: `Piper exited with code ${code}.${stderr ? ` ${stderr.slice(0, 200)}` : ""}` });
        return;
      }
      finish({ pcm: Buffer.concat(chunks), sampleRate: meta.sampleRate });
    });

    proc.stdin.write(text, "utf8");
    proc.stdin.end();
  });
}
