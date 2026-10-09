import { deletePageAsset, pageAssetPath, readPageAsset, savePageAsset } from "../../../core/pageAssets.js";

/** Passport's page backgrounds live in the shared page-asset store (core/pageAssets.ts). */

export function passportAssetPath(guildId: string, assetId: string): string {
  return pageAssetPath(guildId, "passport", assetId);
}

export function readPassportAsset(guildId: string, assetId: string): Buffer | null {
  return readPageAsset(guildId, "passport", assetId);
}

export function deletePassportAsset(guildId: string, assetId: string): boolean {
  return deletePageAsset(guildId, "passport", assetId);
}

/** Normalize an uploaded image into a PNG and store it for the guild. */
export async function savePassportBackgroundAsset(
  guildId: string,
  raw: Buffer,
): Promise<{ assetId: string; bytes: number }> {
  return savePageAsset(guildId, "passport", raw);
}
