import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentBuilder } from "discord.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PLANE_IMAGES_DIR = join(ROOT, "assets", "planes");

const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

mkdirSync(PLANE_IMAGES_DIR, { recursive: true });

/** Plain file name only: no path separators or traversal, and a recognized image extension. */
export function isValidImageKey(key: string): boolean {
  if (!key || key.includes("/") || key.includes("\\") || key.includes("..")) return false;
  return ALLOWED_EXTENSIONS.some((ext) => key.toLowerCase().endsWith(ext));
}

export function planeImagePath(key: string): string | null {
  if (!isValidImageKey(key)) return null;
  return join(PLANE_IMAGES_DIR, key);
}

export function planeImageExists(key: string): boolean {
  const path = planeImagePath(key);
  return path !== null && existsSync(path);
}

/** File names currently sitting in assets/planes/, for autocomplete. */
export function listPlaneImageFiles(): string[] {
  try {
    return readdirSync(PLANE_IMAGES_DIR).filter((f) => ALLOWED_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)));
  } catch {
    return [];
  }
}

/** An attachment + `attachment://` embed URL for a plane's image key, or null if the file is missing. */
export function planeImageAttachment(imageKey: string): { attachment: AttachmentBuilder; url: string } | null {
  if (!imageKey || !planeImageExists(imageKey)) return null;
  return {
    attachment: new AttachmentBuilder(planeImagePath(imageKey)!, { name: imageKey }),
    url: `attachment://${imageKey}`,
  };
}
