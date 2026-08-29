import type { Client, Guild } from "discord.js";
import { listPiperVoiceOptions, synthesizeWithPiper } from "../plugins/tts/functions/piper.js";
import { getUserVoice, setUserVoice } from "../plugins/tts/functions/userVoice.js";
import { resolveDefaultVoice } from "../plugins/tts/functions/piperSetup.js";
import { pcmToWav } from "../plugins/tts/functions/wav.js";
import { addToTtsBlacklist, listTtsBlacklist, removeFromTtsBlacklist } from "../plugins/tts/functions/blacklist.js";

export type TtsVoiceOption = { id: string; label: string; regionCode: string };

export async function listTtsVoicesForWeb(): Promise<TtsVoiceOption[]> {
  return listPiperVoiceOptions();
}

export async function getTtsVoiceForWeb(discordId: string): Promise<{ voice: string | null }> {
  return { voice: await getUserVoice(discordId) };
}

export async function setTtsVoiceForWeb(discordId: string, voice: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const options = await listPiperVoiceOptions();
  if (!options.some((option) => option.id === voice)) {
    return { ok: false, error: `"${voice}" isn't an installed voice.` };
  }
  await setUserVoice(discordId, voice);
  return { ok: true };
}

// Simple per-user cooldown so the preview endpoint can't be hammered — each request spawns a
// real Piper process.
const lastPreview = new Map<string, number>();
const PREVIEW_COOLDOWN_MS = 2000;

export type TtsPreviewResult = { wav: Buffer } | { error: string; status: number };

/** Synthesizes "Hello there, <display name>!" in `voice` (or the caller's saved/default voice). */
export async function synthesizeTtsPreviewForWeb(
  client: Client,
  discordId: string,
  voice?: string,
): Promise<TtsPreviewResult> {
  const last = lastPreview.get(discordId) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < PREVIEW_COOLDOWN_MS) {
    return { error: `Wait ${Math.ceil((PREVIEW_COOLDOWN_MS - elapsed) / 1000)}s before previewing again.`, status: 429 };
  }

  const voiceId = voice || (await getUserVoice(discordId)) || resolveDefaultVoice();
  const options = await listPiperVoiceOptions();
  if (!options.some((option) => option.id === voiceId)) {
    return { error: `"${voiceId}" isn't an installed voice.`, status: 400 };
  }

  let displayName = "there";
  try {
    const user = await client.users.fetch(discordId);
    displayName = user.displayName || user.username;
  } catch {
    // Fall back to the generic greeting below.
  }

  const greeting = displayName === "there" ? "Hello there!" : `Hello there, ${displayName}!`;

  const spoken = await synthesizeWithPiper(greeting, voiceId);
  if ("error" in spoken) {
    return { error: spoken.error, status: 502 };
  }

  lastPreview.set(discordId, Date.now());
  return { wav: pcmToWav(spoken.pcm, spoken.sampleRate, 1) };
}

export type TtsBlacklistEntryForWeb = { userId: string; reason: string | null; createdAt: string };

function toWebEntry(entry: { userId: string; reason: string | null; createdAt: Date }): TtsBlacklistEntryForWeb {
  return { userId: entry.userId, reason: entry.reason, createdAt: entry.createdAt.toISOString() };
}

export async function listGuildTtsBlacklist(guild: Guild): Promise<TtsBlacklistEntryForWeb[]> {
  const entries = await listTtsBlacklist(guild.id);
  return entries.map(toWebEntry);
}

export async function addGuildTtsBlacklist(guild: Guild, userId: string, reason?: string): Promise<TtsBlacklistEntryForWeb[]> {
  await addToTtsBlacklist(guild.id, userId, reason);
  return listGuildTtsBlacklist(guild);
}

export async function removeGuildTtsBlacklist(guild: Guild, userId: string): Promise<TtsBlacklistEntryForWeb[]> {
  await removeFromTtsBlacklist(guild.id, userId);
  return listGuildTtsBlacklist(guild);
}
