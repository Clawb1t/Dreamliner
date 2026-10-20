import { PermissionFlagsBits, type Guild, type GuildTextBasedChannel } from "discord.js";
import { configManager } from "../config/manager.js";
import { isDeepSeekConfigured, type DeepSeekMessage } from "../core/ai/deepseek.js";
import { fetchGuildChannel, validateGuildTargets } from "../core/guildChannel.js";
import { getLogger } from "../core/logger.js";
import { decodeBase64Upload, deletePageAsset, isPageAssetId, readPageAsset, savePageAsset } from "../core/pageAssets.js";
import {
  CATCHPHRASE_LIMITS,
  CHARACTER_LIMITS,
  CHARACTER_TONES,
  EMOJI_USES,
  FORMALITIES,
  REPLY_STYLES,
  TEMPERATURE_DEFAULT,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  type CharacterTone,
  type EmojiUse,
  type Formality,
  type ReplyStyle,
} from "../plugins/characters/constants.js";
import { characterAvatarUrl } from "../plugins/characters/functions/avatar.js";
import { guildHasOne, refundReply, takeReply, usageToday } from "../plugins/characters/functions/limits.js";
import { renderExampleDialogue } from "../plugins/characters/functions/prompt.js";
import { charactersConfigOf, generateCharacterReply, postAsCharacter } from "../plugins/characters/functions/respond.js";
import { canEditRole, canManageRoles, deleteCharacterRole, ensureCharacterRole } from "../plugins/characters/functions/roles.js";
import {
  ReviewUnavailableError,
  reviewCharacter,
  sanitizeCharacterReply,
  type CharacterDefinition,
} from "../plugins/characters/functions/safety.js";
import {
  addTokens,
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
  type CharacterRecord,
  type CharacterWrite,
} from "../plugins/characters/functions/store.js";

const log = getLogger("bridge:characters");

/** Dashboard side of the Characters plugin (routed from dashboardBridge.ts). */

export type CharacterPayload = {
  id: number;
  name: string;
  avatarUrl: string | null;
  avatarAssetId: string | null;
  avatarSourceUrl: string | null;
  tagline: string;
  personality: string;
  scenario: string;
  greeting: string;
  exampleDialogue: string;
  replyStyle: ReplyStyle;
  temperature: number;
  tone: CharacterTone;
  emojiUse: EmojiUse;
  formality: Formality;
  roleplayActions: boolean;
  catchphrases: string[];
  roleId: string | null;
  roleMissing: boolean;
  roleColor: number | null;
  dedicatedChannelIds: string[];
  allowedChannelIds: string[];
  enabled: boolean;
  reviewStatus: "approved" | "rejected";
  reviewReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CharacterResult =
  | { status: 200; body: { ok: true; character: CharacterPayload; review: { approved: boolean; reason: string | null } } }
  | { status: 400 | 403 | 404 | 409; body: { ok: false; error: string; field?: string } };

function fail(status: 400 | 403 | 404 | 409, error: string, field?: string) {
  return { status, body: { ok: false as const, error, ...(field ? { field } : {}) } };
}

export function toCharacterPayload(guild: Guild, c: CharacterRecord): CharacterPayload {
  const role = c.roleId ? guild.roles.cache.get(c.roleId) : undefined;
  return {
    id: c.id,
    name: c.name,
    avatarUrl: characterAvatarUrl(guild.id, c),
    avatarAssetId: c.avatarAssetId,
    avatarSourceUrl: c.avatarUrl,
    tagline: c.tagline,
    personality: c.personality,
    scenario: c.scenario,
    greeting: c.greeting,
    exampleDialogue: c.exampleDialogue,
    replyStyle: c.replyStyle,
    temperature: c.temperature,
    tone: c.tone,
    emojiUse: c.emojiUse,
    formality: c.formality,
    roleplayActions: c.roleplayActions,
    catchphrases: c.catchphrases,
    roleId: role ? c.roleId : null,
    roleMissing: !role,
    roleColor: c.roleColor,
    dedicatedChannelIds: c.dedicatedChannelIds,
    allowedChannelIds: c.allowedChannelIds,
    enabled: c.enabled,
    reviewStatus: c.reviewStatus,
    reviewReason: c.reviewReason,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// --- Overview --------------------------------------------------------------------------------

export async function getCharactersOverview(guild: Guild) {
  const oneActive = await guildHasOne(guild.id);
  const list = listCharacters(guild.id);
  const me = guild.members.me;
  const manageWebhooks = Boolean(me?.permissions.has(PermissionFlagsBits.ManageWebhooks));
  const manageRoles = canManageRoles(guild);
  const available = isDeepSeekConfigured();
  const notes: string[] = [];
  if (!available) notes.push("Character replies aren't available on this bot yet (the AI provider isn't configured).");
  if (!manageWebhooks) {
    notes.push("Dreamliner is missing Manage Webhooks, so characters reply as Dreamliner with their name in bold instead of with their own name and avatar.");
  }
  if (!manageRoles) notes.push("Dreamliner is missing Manage Roles, so it can't create the @roles members mention to talk to characters.");
  const missing = list.filter((c) => !c.roleId || !guild.roles.cache.has(c.roleId));
  if (manageRoles && missing.length) {
    notes.push(`${missing.map((c) => c.name).join(", ")} ${missing.length === 1 ? "has" : "have"} no @role. Use "Recreate role" to make one.`);
  }
  const stuck = list.filter((c) => {
    const role = c.roleId ? guild.roles.cache.get(c.roleId) : undefined;
    return role && manageRoles && !canEditRole(guild, role);
  });
  if (stuck.length) {
    notes.push(
      `Dreamliner's role is below the role of ${stuck.map((c) => c.name).join(", ")}, so it can't rename or recolour ${stuck.length === 1 ? "it" : "them"}. Move Dreamliner's role higher in Server Settings > Roles.`,
    );
  }
  const total = list.length;
  const limit = usageToday(guild.id, oneActive);
  if (total > limit.characterLimit) {
    notes.push(`This server has ${total} characters but its plan allows ${limit.characterLimit}. Existing ones keep working; delete some to add new ones.`);
  }
  return {
    ok: true as const,
    characters: list.map((c) => toCharacterPayload(guild, c)),
    usage: limit,
    available,
    health: { manageWebhooks, manageRoles, notes },
  };
}

// --- Input -----------------------------------------------------------------------------------

type ParsedInput = Partial<Omit<CharacterWrite, "reviewStatus" | "reviewReason" | "reviewedAt">>;

const TEXT_FIELDS = [
  ["name", "name"],
  ["tagline", "tagline"],
  ["personality", "personality"],
  ["scenario", "scenario"],
  ["greeting", "greeting"],
  ["exampleDialogue", "exampleDialogue"],
] as const;

async function channelList(
  guild: Guild,
  raw: unknown,
  max: number,
  field: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string; field: string }> {
  if (!Array.isArray(raw)) return { ok: false, error: "Expected a list of channels.", field };
  const ids = [...new Set(raw)];
  if (ids.length > max) return { ok: false, error: `Pick at most ${max} channels.`, field };
  for (const id of ids) {
    // Cross-server safety: only this guild's own channels can be saved.
    const problem = await validateGuildTargets(guild, { discordChannelId: id });
    if (problem) return { ok: false, error: problem, field };
  }
  return { ok: true, ids: ids as string[] };
}

/** Validates a CharacterInput body. Only the fields present are returned. */
export async function parseCharacterInput(
  guild: Guild,
  body: Record<string, unknown>,
): Promise<{ ok: true; value: ParsedInput } | { ok: false; error: string; field: string }> {
  const value: ParsedInput = {};
  for (const [key, field] of TEXT_FIELDS) {
    const raw = body[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return { ok: false, error: "Expected text.", field };
    const text = key === "name" ? raw.trim().replace(/\s+/g, " ") : raw.replace(/\r\n/g, "\n").trim();
    const max = CHARACTER_LIMITS[key];
    if (text.length > max) return { ok: false, error: `Keep this to ${max} characters or fewer.`, field };
    value[key] = text;
  }

  if (body.replyStyle !== undefined) {
    if (typeof body.replyStyle !== "string" || !(REPLY_STYLES as readonly string[]).includes(body.replyStyle)) {
      return { ok: false, error: "Reply style must be short, medium or long.", field: "replyStyle" };
    }
    value.replyStyle = body.replyStyle as ReplyStyle;
  }
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) {
      return { ok: false, error: "Creativity must be a number.", field: "temperature" };
    }
    value.temperature = Math.round(Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, body.temperature)) * 100) / 100;
  }
  if (body.tone !== undefined) {
    if (typeof body.tone !== "string" || (body.tone !== "" && !(CHARACTER_TONES as readonly string[]).includes(body.tone))) {
      return { ok: false, error: "Pick one of the tone presets.", field: "tone" };
    }
    value.tone = body.tone as CharacterTone;
  }
  if (body.emojiUse !== undefined) {
    if (typeof body.emojiUse !== "string" || !(EMOJI_USES as readonly string[]).includes(body.emojiUse)) {
      return { ok: false, error: "Emoji use must be none, some or lots.", field: "emojiUse" };
    }
    value.emojiUse = body.emojiUse as EmojiUse;
  }
  if (body.formality !== undefined) {
    if (typeof body.formality !== "string" || !(FORMALITIES as readonly string[]).includes(body.formality)) {
      return { ok: false, error: "Formality must be casual, balanced or formal.", field: "formality" };
    }
    value.formality = body.formality as Formality;
  }
  if (body.roleplayActions !== undefined) {
    if (typeof body.roleplayActions !== "boolean") return { ok: false, error: "Expected on or off.", field: "roleplayActions" };
    value.roleplayActions = body.roleplayActions;
  }
  if (body.catchphrases !== undefined) {
    if (!Array.isArray(body.catchphrases) || body.catchphrases.some((p) => typeof p !== "string")) {
      return { ok: false, error: "Expected a list of catchphrases.", field: "catchphrases" };
    }
    const phrases: string[] = [];
    for (const raw of body.catchphrases as string[]) {
      const phrase = raw.replace(/\s+/g, " ").trim();
      if (!phrase) continue;
      if (phrase.length > CATCHPHRASE_LIMITS.length) {
        return { ok: false, error: `Keep each catchphrase to ${CATCHPHRASE_LIMITS.length} characters or fewer.`, field: "catchphrases" };
      }
      if (!phrases.some((p) => p.toLowerCase() === phrase.toLowerCase())) phrases.push(phrase);
    }
    if (phrases.length > CATCHPHRASE_LIMITS.count) {
      return { ok: false, error: `A character can have at most ${CATCHPHRASE_LIMITS.count} catchphrases.`, field: "catchphrases" };
    }
    value.catchphrases = phrases;
  }
  if (body.roleColor !== undefined) {
    if (body.roleColor !== null && (typeof body.roleColor !== "number" || !Number.isInteger(body.roleColor) || body.roleColor < 0 || body.roleColor > 0xffffff)) {
      return { ok: false, error: "Role colour must be a colour like #5865F2.", field: "roleColor" };
    }
    value.roleColor = body.roleColor as number | null;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "Expected on or off.", field: "enabled" };
    value.enabled = body.enabled;
  }

  if (body.avatarAssetId !== undefined) {
    if (body.avatarAssetId === null || body.avatarAssetId === "") value.avatarAssetId = null;
    else if (typeof body.avatarAssetId !== "string" || !isPageAssetId(body.avatarAssetId) || !readPageAsset(guild.id, "characters", body.avatarAssetId)) {
      return { ok: false, error: "That avatar upload wasn't found. Upload it again.", field: "avatarAssetId" };
    } else value.avatarAssetId = body.avatarAssetId;
  }
  if (body.avatarUrl !== undefined) {
    if (body.avatarUrl === null || body.avatarUrl === "") value.avatarUrl = null;
    else {
      const raw = typeof body.avatarUrl === "string" ? body.avatarUrl.trim() : "";
      let ok = false;
      try {
        ok = raw.length <= CHARACTER_LIMITS.avatarUrl && new URL(raw).protocol === "https:";
      } catch {
        ok = false;
      }
      if (!ok) return { ok: false, error: "Use an https:// image link.", field: "avatarUrl" };
      value.avatarUrl = raw;
    }
  }
  // One avatar source at a time: an upload wins over a link.
  if (value.avatarAssetId) value.avatarUrl = null;
  else if (value.avatarUrl) value.avatarAssetId = null;

  if (body.dedicatedChannelIds !== undefined) {
    const parsed = await channelList(guild, body.dedicatedChannelIds, CHARACTER_LIMITS.dedicatedChannels, "dedicatedChannelIds");
    if (!parsed.ok) return parsed;
    value.dedicatedChannelIds = parsed.ids;
  }
  if (body.allowedChannelIds !== undefined) {
    const parsed = await channelList(guild, body.allowedChannelIds, CHARACTER_LIMITS.allowedChannels, "allowedChannelIds");
    if (!parsed.ok) return parsed;
    value.allowedChannelIds = parsed.ids;
  }
  return { ok: true, value };
}

const REVIEWED_FIELDS = ["name", "tagline", "personality", "scenario", "greeting", "exampleDialogue"] as const;
const NOT_AI_REVIEWED_NOTE = "Saved without an AI review: character replies aren't available on this bot yet.";

function definitionOf(c: Pick<CharacterRecord, (typeof REVIEWED_FIELDS)[number] | "tone" | "catchphrases">): CharacterDefinition {
  return {
    name: c.name,
    tagline: c.tagline,
    personality: c.personality,
    scenario: c.scenario,
    greeting: c.greeting,
    exampleDialogue: c.exampleDialogue,
    tone: c.tone,
    catchphrases: c.catchphrases,
  };
}

function nameTaken(guildId: string, name: string, exceptId?: number): boolean {
  const lower = name.toLowerCase();
  return listCharacters(guildId).some((c) => c.id !== exceptId && c.name.toLowerCase() === lower);
}

function cleanupAvatar(guildId: string, previous: CharacterRecord, next: CharacterRecord | null): void {
  if (previous.avatarAssetId && previous.avatarAssetId !== next?.avatarAssetId) {
    if (!listCharacters(guildId).some((c) => c.avatarAssetId === previous.avatarAssetId)) {
      deletePageAsset(guildId, "characters", previous.avatarAssetId);
    }
  }
}

// --- Create / update / delete ------------------------------------------------------------

export async function createWebCharacter(guild: Guild, userId: string, body: Record<string, unknown>): Promise<CharacterResult> {
  const parsed = await parseCharacterInput(guild, body);
  if (!parsed.ok) return fail(400, parsed.error, parsed.field);
  const input = parsed.value;
  if (!input.name) return fail(400, "Give the character a name.", "name");
  if (!input.personality) return fail(400, "Describe the character's personality.", "personality");
  if (nameTaken(guild.id, input.name)) return fail(400, "Another character already has that name.", "name");

  const oneActive = await guildHasOne(guild.id);
  const { characterLimit } = usageToday(guild.id, oneActive);
  if (listCharacters(guild.id).length >= characterLimit) {
    return fail(
      409,
      oneActive
        ? `This server has reached the limit of ${characterLimit} characters.`
        : `Free servers can have ${characterLimit} characters. Dreamliner One raises that to 25.`,
    );
  }

  const definition: CharacterDefinition = {
    name: input.name,
    tagline: input.tagline ?? "",
    personality: input.personality,
    scenario: input.scenario ?? "",
    greeting: input.greeting ?? "",
    exampleDialogue: input.exampleDialogue ?? "",
    tone: input.tone ?? "",
    catchphrases: input.catchphrases ?? [],
  };
  let verdict;
  try {
    verdict = await reviewCharacter(definition);
  } catch (err) {
    if (err instanceof ReviewUnavailableError) return fail(400, "The character review couldn't run right now. Please try again in a minute.");
    throw err;
  }
  if (!verdict.approved && verdict.category === "name" && verdict.field === "name") {
    // A bad name is a plain form error, not something to save.
    return fail(400, verdict.reason ?? "Pick a different name.", "name");
  }

  const record = createCharacter(guild.id, userId, {
    ...definition,
    tone: input.tone ?? "",
    emojiUse: input.emojiUse ?? "some",
    formality: input.formality ?? "balanced",
    roleplayActions: input.roleplayActions ?? true,
    catchphrases: input.catchphrases ?? [],
    avatarAssetId: input.avatarAssetId ?? null,
    avatarUrl: input.avatarUrl ?? null,
    replyStyle: input.replyStyle ?? "medium",
    temperature: input.temperature ?? TEMPERATURE_DEFAULT,
    roleColor: input.roleColor ?? null,
    dedicatedChannelIds: input.dedicatedChannelIds ?? [],
    allowedChannelIds: input.allowedChannelIds ?? [],
    enabled: verdict.approved ? (input.enabled ?? true) : false,
    reviewStatus: verdict.approved ? "approved" : "rejected",
    reviewReason: verdict.approved ? null : verdict.reason,
    reviewedAt: verdict.aiReviewed ? new Date() : null,
  });
  await ensureCharacterRole(guild, record).catch((err) => log.warn(`Role setup failed for character ${record.id}:`, err));
  const fresh = getCharacter(guild.id, record.id) ?? record;
  return {
    status: 200,
    body: {
      ok: true,
      character: toCharacterPayload(guild, fresh),
      review: { approved: verdict.approved, reason: verdict.approved ? (verdict.aiReviewed ? null : NOT_AI_REVIEWED_NOTE) : verdict.reason },
    },
  };
}

export async function updateWebCharacter(guild: Guild, id: number, body: Record<string, unknown>): Promise<CharacterResult> {
  const existing = getCharacter(guild.id, id);
  if (!existing) return fail(404, "That character doesn't exist any more.");
  const parsed = await parseCharacterInput(guild, body);
  if (!parsed.ok) return fail(400, parsed.error, parsed.field);
  const input = parsed.value;
  if (input.name !== undefined && !input.name) return fail(400, "Give the character a name.", "name");
  if (input.personality !== undefined && !input.personality) return fail(400, "Describe the character's personality.", "personality");
  if (input.name && nameTaken(guild.id, input.name, id)) return fail(400, "Another character already has that name.", "name");

  const next = {
    ...definitionOf(existing),
    ...Object.fromEntries(REVIEWED_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]])),
    ...(input.tone !== undefined ? { tone: input.tone } : {}),
    ...(input.catchphrases !== undefined ? { catchphrases: input.catchphrases } : {}),
  } as CharacterDefinition;
  const textChanged =
    REVIEWED_FIELDS.some((f) => next[f] !== existing[f]) ||
    (next.tone ?? "") !== existing.tone ||
    JSON.stringify(next.catchphrases ?? []) !== JSON.stringify(existing.catchphrases);
  // Re-review when the text changed, or when it was only checked locally and the AI is available now.
  const needsReview = textChanged || (!existing.reviewedAt && isDeepSeekConfigured());

  const patch: Partial<CharacterWrite> = { ...input };
  let review: { approved: boolean; reason: string | null };
  if (needsReview) {
    let verdict;
    try {
      verdict = await reviewCharacter(next);
    } catch (err) {
      if (err instanceof ReviewUnavailableError) return fail(400, "The character review couldn't run right now. Please try again in a minute.");
      throw err;
    }
    if (!verdict.approved && verdict.category === "name" && verdict.field === "name") {
      return fail(400, verdict.reason ?? "Pick a different name.", "name");
    }
    patch.reviewStatus = verdict.approved ? "approved" : "rejected";
    patch.reviewReason = verdict.approved ? null : verdict.reason;
    patch.reviewedAt = verdict.aiReviewed ? new Date() : null;
    if (!verdict.approved) patch.enabled = false;
    review = { approved: verdict.approved, reason: verdict.approved ? (verdict.aiReviewed ? null : NOT_AI_REVIEWED_NOTE) : verdict.reason };
  } else {
    review = { approved: existing.reviewStatus === "approved", reason: existing.reviewStatus === "approved" ? null : existing.reviewReason };
  }
  // A character that needs changes stays off until it passes review.
  if ((patch.reviewStatus ?? existing.reviewStatus) === "rejected") patch.enabled = false;

  const updated = updateCharacter(guild.id, id, patch);
  if (!updated) return fail(404, "That character doesn't exist any more.");
  cleanupAvatar(guild.id, existing, updated);
  if (updated.name !== existing.name || updated.roleColor !== existing.roleColor) {
    await ensureCharacterRole(guild, updated).catch((err) => log.warn(`Role sync failed for character ${id}:`, err));
  }
  const fresh = getCharacter(guild.id, id) ?? updated;
  return { status: 200, body: { ok: true, character: toCharacterPayload(guild, fresh), review } };
}

export async function deleteWebCharacter(guild: Guild, id: number): Promise<boolean> {
  const removed = deleteCharacter(guild.id, id);
  if (!removed) return false;
  cleanupAvatar(guild.id, removed, null);
  await deleteCharacterRole(guild, removed.roleId).catch(() => null);
  return true;
}

// --- Actions ---------------------------------------------------------------------------------

export async function recreateWebCharacterRole(guild: Guild, id: number): Promise<{ ok: true; roleId: string } | { ok: false; error: string }> {
  const character = getCharacter(guild.id, id);
  if (!character) return { ok: false, error: "That character doesn't exist any more." };
  const result = await ensureCharacterRole(guild, character);
  return result.roleId ? { ok: true, roleId: result.roleId } : { ok: false, error: result.error ?? "Couldn't create the role." };
}

export async function greetWebCharacter(
  guild: Guild,
  id: number,
  channelId: unknown,
): Promise<{ ok: true; messageUrl: string | null } | { ok: false; error: string }> {
  const character = getCharacter(guild.id, id);
  if (!character) return { ok: false, error: "That character doesn't exist any more." };
  if (character.reviewStatus !== "approved") return { ok: false, error: "This character needs changes before it can post." };
  if (typeof channelId !== "string") return { ok: false, error: "Pick a channel." };
  const channel = await fetchGuildChannel(guild.client, guild.id, channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) {
    return { ok: false, error: "That channel isn't a text channel in this server." };
  }
  const me = guild.members.me;
  if (!me || !(channel as GuildTextBasedChannel).permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) {
    return { ok: false, error: "Dreamliner can't see that channel." };
  }
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = charactersConfigOf(guildConfig);
  const greeting = sanitizeCharacterReply(renderExampleDialogue(character.greeting, character.name).replace(/\bMember\b/g, "everyone"), {
    maxChars: config.max_reply_chars,
    characterName: character.name,
    userName: "everyone",
  });
  if (!greeting) return { ok: false, error: "Write a greeting first." };
  try {
    const messageUrl = await postAsCharacter(channel as GuildTextBasedChannel, character, greeting);
    return { ok: true, messageUrl };
  } catch (err) {
    log.warn(`Greeting failed for character ${id} in ${guild.id}: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: "Discord didn't let Dreamliner post in that channel. Check its permissions there." };
  }
}

export async function testWebCharacter(
  guild: Guild,
  id: number,
  userId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  const character = getCharacter(guild.id, id);
  if (!character) return { ok: false, error: "That character doesn't exist any more." };
  if (character.reviewStatus !== "approved") return { ok: false, error: "This character needs changes before it can talk." };
  if (!isDeepSeekConfigured()) return { ok: false, error: "Character replies aren't available on this bot yet." };
  const raw = Array.isArray(body.messages) ? body.messages : null;
  if (!raw || raw.length === 0) return { ok: false, error: "Write a message to test with." };
  if (raw.length > 20) return { ok: false, error: "A test chat can have at most 20 messages. Start a new one." };
  const member = await guild.members.fetch(userId).catch(() => null);
  const userName = member?.displayName ?? "Tester";
  const history: DeepSeekMessage[] = [];
  for (const item of raw) {
    const m = item as { role?: unknown; content?: unknown };
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return { ok: false, error: "Each message needs a role (user or assistant) and some text." };
    }
    if (m.content.length > 2000) return { ok: false, error: "Each message can be at most 2000 characters." };
    const content = m.content.trim();
    if (!content) continue;
    history.push(m.role === "user" ? { role: "user", content: `${userName}: ${content}` } : { role: "assistant", content });
  }
  if (history[history.length - 1]?.role !== "user") return { ok: false, error: "Write a message to test with." };

  const oneActive = await guildHasOne(guild.id);
  if (!takeReply(guild.id, oneActive)) return { ok: false, error: "This server has used all of today's character replies." };
  try {
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    const { text, usage } = await generateCharacterReply({
      character,
      guildName: guild.name,
      config: charactersConfigOf(guildConfig),
      history,
      userName,
    });
    addTokens(guild.id, usage.input, usage.output);
    if (!text) {
      refundReply(guild.id);
      return { ok: false, error: "That reply was blocked by the safety filter. Try a different message." };
    }
    return { ok: true, reply: text };
  } catch (err) {
    refundReply(guild.id);
    log.warn(`Test chat failed for character ${id} in ${guild.id}: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: "The character couldn't answer right now. Try again in a moment." };
  }
}

// --- Avatars ---------------------------------------------------------------------------------

export async function uploadCharacterAvatar(guild: Guild, imageBase64: unknown): Promise<{ ok: true; assetId: string } | { ok: false; error: string }> {
  if (typeof imageBase64 !== "string" || !imageBase64) return { ok: false, error: "imageBase64 is required" };
  try {
    const saved = await savePageAsset(guild.id, "characters", decodeBase64Upload(imageBase64));
    return { ok: true, assetId: saved.assetId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to upload image" };
  }
}

export function readCharacterAvatar(guild: Guild, assetId: string): Buffer | null {
  return isPageAssetId(assetId) ? readPageAsset(guild.id, "characters", assetId) : null;
}
