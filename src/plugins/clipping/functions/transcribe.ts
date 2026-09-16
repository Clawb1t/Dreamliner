/**
 * Speech-to-text for an exported clip's mixed audio, run fully locally via @huggingface/transformers
 * (ONNX Whisper, no network calls once the model is cached) — no audio ever leaves the machine.
 * Always runs in the background after /clip has already replied — transcription can take several
 * seconds and must never hold up the command's response.
 */

import path from "node:path";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("clipping");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const WHISPER_SAMPLE_RATE = 16000;
const MODEL_ID = "Xenova/whisper-base.en";
const MODEL_CACHE_DIR = path.resolve(process.cwd(), "data", "whisper");

export type TranscriptSegment = { startMs: number; endMs: number; text: string };

type AsrChunk = { timestamp: [number, number | null]; text: string };
type AsrPipeline = (
  audio: Float32Array,
  options: { return_timestamps: boolean; chunk_length_s: number; stride_length_s: number },
) => Promise<{ text: string; chunks?: AsrChunk[] }>;

let pipelinePromise: Promise<AsrPipeline> | null = null;

async function getPipeline(): Promise<AsrPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = MODEL_CACHE_DIR;
      return (await pipeline("automatic-speech-recognition", MODEL_ID)) as unknown as AsrPipeline;
    })().catch((err) => {
      pipelinePromise = null;
      throw err;
    });
  }
  return pipelinePromise;
}

/** Downmixes interleaved s16le stereo PCM at 48kHz to mono Float32 samples at 16kHz — the exact
 *  format Whisper's feature extractor expects. Uses simple linear interpolation for resampling,
 *  which is plenty accurate for speech at this ratio. */
function pcmToWhisperInput(pcm: Buffer): Float32Array {
  const frameCount = Math.floor(pcm.length / (2 * CHANNELS));
  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const offset = i * CHANNELS * 2;
    const left = pcm.readInt16LE(offset);
    const right = pcm.readInt16LE(offset + 2);
    mono[i] = (left + right) / 2 / 32768;
  }

  const ratio = SAMPLE_RATE / WHISPER_SAMPLE_RATE;
  const outLength = Math.floor(frameCount / ratio);
  const resampled = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const a = mono[srcIndex] ?? 0;
    const b = mono[srcIndex + 1] ?? a;
    resampled[i] = a + (b - a) * frac;
  }

  return resampled;
}

/** Returns null (not an error) when transcription fails or produces nothing — a missing
 *  transcript is always an acceptable degraded state, never a reason to fail the clip. */
export async function transcribeClipAudio(pcm: Buffer): Promise<TranscriptSegment[] | null> {
  try {
    const transcriber = await getPipeline();
    const input = pcmToWhisperInput(pcm);

    const output = await transcriber(input, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    if (!output.chunks || output.chunks.length === 0) return null;

    const segments = output.chunks
      .map((c) => ({
        startMs: Math.round(c.timestamp[0] * 1000),
        endMs: Math.round((c.timestamp[1] ?? c.timestamp[0]) * 1000),
        text: c.text.trim(),
      }))
      .filter((s) => s.text.length > 0);

    return segments.length > 0 ? segments : null;
  } catch (err) {
    log.error("Local transcription failed:", err);
    return null;
  }
}
