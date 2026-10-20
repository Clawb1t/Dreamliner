import { getSiteUrl } from "../../../core/docsUrl.js";

/**
 * The public URL of a character's avatar. Uploaded avatars are served by the website, which
 * proxies the bridge's avatar route; a pasted https URL is used as it is. Null = default avatar.
 */
export function characterAvatarUrl(guildId: string, character: { avatarAssetId: string | null; avatarUrl: string | null }): string | null {
  if (character.avatarAssetId) {
    return `${getSiteUrl().replace(/\/$/, "")}/api/characters/${guildId}/avatar/${encodeURIComponent(character.avatarAssetId)}`;
  }
  return character.avatarUrl || null;
}
