import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Installs Piper (https://github.com/rhasspy/piper) and a default voice on first boot if
 * they aren't already present, so `/tts` works out of the box on a fresh deploy (including
 * Pterodactyl-style panel hosts) with no manual setup step. Safe to call on every boot —
 * it's a no-op once the binary and default voice exist.
 *
 * Set PIPER_BIN / PIPER_VOICES_DIR to take full manual control instead; when either is set
 * this does nothing.
 */

const DEFAULT_ROOT = path.resolve(process.cwd(), "data", "piper");
const DEFAULT_VOICE_ID = "en_US-lessac-medium";

function piperRoot(): string {
  return path.resolve(process.env.PIPER_ROOT?.trim() || DEFAULT_ROOT);
}

export function resolvePiperBin(): string {
  const configured = process.env.PIPER_BIN?.trim();
  if (configured) return configured;
  const exe = process.platform === "win32" ? "piper.exe" : "piper";
  return path.join(piperRoot(), "bin", exe);
}

export function resolvePiperVoicesDir(): string {
  const configured = process.env.PIPER_VOICES_DIR?.trim();
  if (configured) return configured;
  return path.join(piperRoot(), "voices");
}

export function resolveDefaultVoice(): string {
  return process.env.PIPER_DEFAULT_VOICE?.trim() || DEFAULT_VOICE_ID;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Release asset name for this host, per https://github.com/rhasspy/piper/releases. */
function releaseAssetName(): string | null {
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return "piper_windows_amd64.zip";
  if (platform === "linux" && arch === "x64") return "piper_linux_x86_64.tar.gz";
  if (platform === "linux" && arch === "arm64") return "piper_linux_aarch64.tar.gz";
  if (platform === "darwin" && arch === "x64") return "piper_macos_x64.tar.gz";
  if (platform === "darwin" && arch === "arm64") return "piper_macos_aarch64.tar.gz";
  return null;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(destPath));
}

/** Extracts a .zip or .tar.gz with the system `tar` (bsdtar on Windows, GNU/BSD tar elsewhere). */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("tar", ["-xf", archivePath, "-C", destDir]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}.${stderr ? ` ${stderr.slice(0, 300)}` : ""}`));
    });
  });
}

async function findFileRecursive(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function installPiperBinary(binPath: string): Promise<void> {
  const asset = releaseAssetName();
  if (!asset) {
    throw new Error(`No known Piper release for ${process.platform}/${process.arch}. Set PIPER_BIN manually.`);
  }

  const binDir = path.dirname(binPath);
  await mkdir(binDir, { recursive: true });

  const tmpDir = path.join(piperRoot(), `.tmp-download-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    const archivePath = path.join(tmpDir, asset);
    console.log(`[tts] Downloading Piper (${asset})...`);
    await downloadFile(`https://github.com/rhasspy/piper/releases/latest/download/${asset}`, archivePath);

    console.log("[tts] Extracting Piper...");
    await extractArchive(archivePath, tmpDir);

    const exeName = process.platform === "win32" ? "piper.exe" : "piper";
    const foundExe = await findFileRecursive(tmpDir, exeName);
    if (!foundExe) throw new Error("Downloaded archive did not contain a piper executable.");

    // Move everything alongside the executable (shared libs, espeak-ng-data, etc.) into place.
    const extractedRoot = path.dirname(foundExe);
    for (const entry of await readdir(extractedRoot)) {
      await rename(path.join(extractedRoot, entry), path.join(binDir, entry));
    }

    if (process.platform !== "win32") await chmod(binPath, 0o755);
    console.log(`[tts] Piper installed at ${binPath}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** `en_US-lessac-medium` -> `en/en_US/lessac/medium` (the piper-voices repo's layout). */
function voiceHuggingFacePath(voiceId: string): string | null {
  const parts = voiceId.split("-");
  if (parts.length !== 3) return null;
  const [langFull, name, quality] = parts;
  const lang2 = langFull.split("_")[0];
  if (!lang2 || !name || !quality) return null;
  return `${lang2}/${langFull}/${name}/${quality}/${voiceId}`;
}

async function installDefaultVoice(voicesDir: string, voiceId: string): Promise<void> {
  const hfPath = voiceHuggingFacePath(voiceId);
  if (!hfPath) {
    throw new Error(`Don't know how to auto-download voice "${voiceId}". Add <id>.onnx/<id>.onnx.json to ${voicesDir} manually.`);
  }

  await mkdir(voicesDir, { recursive: true });
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${hfPath}`;
  console.log(`[tts] Downloading default Piper voice (${voiceId})...`);
  await downloadFile(`${base}.onnx`, path.join(voicesDir, `${voiceId}.onnx`));
  await downloadFile(`${base}.onnx.json`, path.join(voicesDir, `${voiceId}.onnx.json`));
  console.log(`[tts] Voice ${voiceId} installed at ${voicesDir}`);
}

export type EnsurePiperResult = { ok: true } | { ok: false; reason: string };

/** Idempotent: downloads whatever's missing (binary and/or default voice), skips the rest. */
export async function ensurePiperReady(): Promise<EnsurePiperResult> {
  const bin = resolvePiperBin();
  const voicesDir = resolvePiperVoicesDir();

  try {
    if (!(await fileExists(bin))) {
      await installPiperBinary(bin);
    }
  } catch (error) {
    return { ok: false, reason: `Could not install Piper: ${error instanceof Error ? error.message : String(error)}` };
  }

  const voiceId = resolveDefaultVoice();
  const onnxPath = path.join(voicesDir, `${voiceId}.onnx`);
  try {
    if (!(await fileExists(onnxPath))) {
      await installDefaultVoice(voicesDir, voiceId);
    }
  } catch (error) {
    return { ok: false, reason: `Could not install default Piper voice: ${error instanceof Error ? error.message : String(error)}` };
  }

  return { ok: true };
}
