import { getLastfmUsername, setLastfmUsername, clearLastfmUsername } from "../plugins/utility/functions/lastfmConnection.js";
import { getLastfmUserInfo, LastfmError } from "../plugins/utility/functions/lastfm.js";

export async function getLastfmForWeb(discordId: string): Promise<{ username: string | null }> {
  return { username: await getLastfmUsername(discordId) };
}

export async function setLastfmForWeb(
  discordId: string,
  username: string,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const trimmed = username.trim();
  if (!trimmed) return { ok: false, error: "Enter a Last.fm username." };
  try {
    const check = await getLastfmUserInfo(trimmed);
    if (!check.ok) return { ok: false, error: `No Last.fm account named "${trimmed}" exists.` };
    await setLastfmUsername(discordId, check.name);
    return { ok: true, username: check.name };
  } catch (error) {
    if (error instanceof LastfmError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function clearLastfmForWeb(discordId: string): Promise<void> {
  await clearLastfmUsername(discordId);
}
