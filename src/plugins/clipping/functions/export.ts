/**
 * Muxes a mixed PCM track into a compact mp4 — needed even though a voice clip has no real video,
 * because Discord's link unfurler only renders an inline playable embed for files with a video
 * track. The video content is ffmpeg's own `gradients` source filter — an animated, slowly
 * rotating gradient, seeded from the clip id so it's colorful and distinct per clip without any
 * per-clip rendering work (no canvas, no avatar fetching). Its palette matches the same dark-navy
 * + accent-hue language as the website's SVG thumbnails (clipThumbnail.ts) for visual consistency,
 * even though the two are generated completely independently in different places.
 *
 * prism.FFmpeg (used elsewhere in this repo, e.g. tts/functions/resample.ts) always forces stdout
 * output, which doesn't fit here: this step needs two inputs (the gradient source plus piped PCM
 * audio) muxed into a real, seekable output *file* (`-movflags +faststart` needs a seekable
 * target). So ffmpeg is spawned directly instead, using the same ffmpeg-static binary.
 */

import { spawn } from "node:child_process";
import { mkdirSync, unlinkSync, statSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLIPS_ROOT = join(ROOT, "data", "guild-assets");

// The website displays the player up to 960px wide (see .clip-player in globals.css), so 640x360
// was being upscaled 1.5x on top of an already-low default CRF — the combination read as grainy/
// blocky, especially on a smooth gradient where quantization banding is most visible.
const VISUAL_WIDTH = 1280;
const VISUAL_HEIGHT = 720;

function safeSegment(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== id) throw new Error("Invalid clip id");
  return safe;
}

function hashSeed(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `0x${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

export function clipDir(guildId: string): string {
  return join(CLIPS_ROOT, guildId, "clips");
}

export function clipFilePath(guildId: string, clipId: string): string {
  return join(clipDir(guildId), `${safeSegment(clipId)}.mp4`);
}

function runFfmpegMux(pcm: Buffer, outputPath: string, seed: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const hueBase = seed % 360;
    const c0 = hslToHex(hueBase, 45, 14);
    const c1 = hslToHex((hueBase + 60) % 360, 65, 45);
    const gradientType = seed % 2 === 0 ? "circular" : "spiral";
    const gradientsSource =
      `gradients=s=${VISUAL_WIDTH}x${VISUAL_HEIGHT}:r=25:c0=${c0}:c1=${c1}:` +
      `type=${gradientType}:speed=0.02:seed=${seed % 2147483647}`;

    const args = [
      "-y",
      "-f", "lavfi",
      "-i", gradientsSource,
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-i", "-",
      "-c:v", "libx264",
      "-preset", "veryfast",
      // Left at x264's default (23) this near-static gradient content encodes so efficiently that
      // the resulting bitrate is too low to avoid visible banding once upscaled in the player —
      // 18 costs almost nothing in file size here but removes the banding/grain.
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      // A 1-second keyframe interval so a later trim (webClips.ts's updateClip, stream-copy only)
      // lands close to the requested cut point.
      "-r", "25",
      "-g", "25",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ];

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });

    proc.stdin.end(pcm);
  });
}

export type ExportedClip = { filePath: string; fileName: string; byteSize: number };

/** Muxes `pcm` (48kHz stereo s16le) with a seeded animated gradient background and writes the
 *  result to disk under data/guild-assets/<guildId>/clips/<clipId>.mp4. */
export async function exportClip(params: { guildId: string; clipId: string; pcm: Buffer }): Promise<ExportedClip> {
  const dir = clipDir(params.guildId);
  mkdirSync(dir, { recursive: true });

  const clipId = safeSegment(params.clipId);
  const outputPath = clipFilePath(params.guildId, params.clipId);

  await runFfmpegMux(params.pcm, outputPath, hashSeed(clipId));

  const byteSize = statSync(outputPath).size;
  return { filePath: outputPath, fileName: `${clipId}.mp4`, byteSize };
}

export function readClipFile(guildId: string, clipId: string): Buffer | null {
  try {
    return readFileSync(clipFilePath(guildId, clipId));
  } catch {
    return null;
  }
}

export function deleteClipFile(guildId: string, clipId: string): boolean {
  try {
    unlinkSync(clipFilePath(guildId, clipId));
    return true;
  } catch {
    return false;
  }
}

export type TrimResult = { ok: true; byteSize: number; durationMs: number } | { ok: false; error: string };

/** Cuts an already-exported clip down to [startMs, endMs) with a stream-copy (no re-encode —
 *  fast, and the only lossy part is landing on the nearest keyframe, which export.ts already
 *  keeps within ~1s). Replaces the file in place; the caller is responsible for updating the
 *  clip's stored durationMs/byteSize with the returned values. */
export async function trimClipFile(guildId: string, clipId: string, startMs: number, endMs: number): Promise<TrimResult> {
  if (!(endMs > startMs)) return { ok: false, error: "End must be after start." };

  const existingPath = clipFilePath(guildId, clipId);
  const tmpPath = `${existingPath}.trim.mp4`;
  const args = [
    "-y",
    "-ss", (startMs / 1000).toFixed(3),
    "-to", (endMs / 1000).toFixed(3),
    "-i", existingPath,
    "-c", "copy",
    tmpPath,
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.once("error", reject);
      proc.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg trim exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up if ffmpeg never produced output.
    }
    return { ok: false, error: err instanceof Error ? err.message : "Trim failed." };
  }

  renameSync(tmpPath, existingPath);
  const byteSize = statSync(existingPath).size;
  return { ok: true, byteSize, durationMs: endMs - startMs };
}
