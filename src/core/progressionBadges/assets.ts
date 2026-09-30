import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Progression badge art lives in `assets/badges/progression/`:
 *   - `<badgeId>.<ext>` for a badge with one look (e.g. `dreamliner_one.svg`)
 *   - `<badgeId>/<tier>.<ext>` for a badge that evolves (e.g. `messages/1.png`, `messages/2.png`)
 * A badge is only ever shown when its art exists, so a new badge can be wired up in code first
 * and appears the moment its images are dropped in. The folder is re-scanned every minute, so no
 * restart is needed after adding images.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PROGRESSION_BADGE_DIR = join(ROOT, "assets", "badges", "progression");

const EXTENSIONS = ["svg", "png", "webp", "gif"] as const;
const CONTENT_TYPES: Record<(typeof EXTENSIONS)[number], string> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
const SCAN_TTL_MS = 60_000;
const SAFE_SEGMENT = /^[a-z0-9_-]+$/;

export type BadgeImage = {
  /** Path relative to the badge folder, e.g. "messages/2.png". Used in the image URL. */
  key: string;
  /** Changes when the file changes, for cache busting. */
  version: string;
  path: string;
  contentType: string;
};

let index: Map<string, BadgeImage> | null = null;
let scannedAt = 0;

function fileEntry(key: string, path: string): BadgeImage | null {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase() as (typeof EXTENSIONS)[number];
  if (!EXTENSIONS.includes(ext)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { key, version: Math.floor(stat.mtimeMs).toString(36), path, contentType: CONTENT_TYPES[ext] };
  } catch {
    return null;
  }
}

function scan(): Map<string, BadgeImage> {
  const found = new Map<string, BadgeImage>();
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(PROGRESSION_BADGE_DIR, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      const image = fileEntry(entry.name, join(PROGRESSION_BADGE_DIR, entry.name));
      if (image) found.set(image.key, image);
    } else if (entry.isDirectory() && SAFE_SEGMENT.test(entry.name)) {
      let files: string[];
      try {
        files = readdirSync(join(PROGRESSION_BADGE_DIR, entry.name));
      } catch {
        continue;
      }
      for (const file of files) {
        const image = fileEntry(`${entry.name}/${file}`, join(PROGRESSION_BADGE_DIR, entry.name, file));
        if (image) found.set(image.key, image);
      }
    }
  }
  return found;
}

function imageIndex(): Map<string, BadgeImage> {
  if (!index || Date.now() - scannedAt > SCAN_TTL_MS) {
    index = scan();
    scannedAt = Date.now();
  }
  return index;
}

/** The art for a badge (and tier, for evolving badges), or null if none has been added yet. */
export function findBadgeImage(badgeId: string, tier: number | null): BadgeImage | null {
  const base = tier == null ? badgeId : `${badgeId}/${tier}`;
  const images = imageIndex();
  for (const ext of EXTENSIONS) {
    const image = images.get(`${base}.${ext}`);
    if (image) return image;
  }
  return null;
}

/** Looks an image up by its key. Only files found by the scan are served, so a key can never
 *  reach outside the badge folder. */
export function getBadgeImageByKey(key: string): BadgeImage | null {
  return imageIndex().get(key) ?? null;
}

const bufferCache = new Map<string, { version: string; buffer: Buffer }>();

export function readBadgeImage(image: BadgeImage): Buffer {
  const cached = bufferCache.get(image.key);
  if (cached && cached.version === image.version) return cached.buffer;
  const buffer = readFileSync(image.path);
  bufferCache.set(image.key, { version: image.version, buffer });
  return buffer;
}

/** Test hook: forget the scan so the next lookup re-reads the folder. */
export function resetBadgeImageIndex(): void {
  index = null;
  scannedAt = 0;
}
