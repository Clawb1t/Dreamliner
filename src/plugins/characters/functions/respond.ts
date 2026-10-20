import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zCharactersConfig, type CharactersConfig } from "../../../config/schemas/characters.js";
import { chatCompletion, isDeepSeekConfigured, type DeepSeekMessage, type DeepSeekUsage } from "../../../core/ai/deepseek.js";
import { getLogger } from "../../../core/logger.js";
import { capMap } from "../../../core/mapPrune.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import {
  getOwnedWebhook,
  invalidateOwnedWebhook,
  isOwnWebhookId,
  isUnknownWebhookError,
  type OwnedWebhook,
} from "../../../core/webhooks.js";
import { CHARACTERS_WEBHOOK_NAME, PLUGIN } from "../constants.js";
import { characterAvatarUrl } from "./avatar.js";
import { guildHasOne, noteMemberReply, refundReply, takeReply } from "./limits.js";
import {
  REPLY_CONTEXT_PREFIX,
  buildCharacterPrompt,
  buildChatMessages,
  buildHistory,
  maxTokensFor,
  type HistoryMessage,
} from "./prompt.js";
import { ReviewUnavailableError, reviewCharacter, sanitizeCharacterReply } from "./safety.js";
import { addTokens, getCharacter, getMemoryReset, updateCharacter, type CharacterRecord } from "./store.js";

const log = getLogger("characters");

/** What a character's placeholder becomes when the reply couldn't be made. */
export const FAIL_TEXT = "*…(lost my train of thought)*";

export function charactersConfigOf(guildConfig: Parameters<typeof getPluginSettings>[0]): CharactersConfig {
  return parsePluginConfig(zCharactersConfig, getPluginSettings(guildConfig, PLUGIN));
}

/** The placeholder shown while the reply is written: the server's typing text. */
export function typingTextFor(config: Pick<CharactersConfig, "typing_text">, name: string): string {
  return (config.typing_text.trim() || "*{name} is typing…*").replaceAll("{name}", name);
}

/** Prefix of a character's message in the fallback (no Manage Webhooks) mode. */
function fallbackPrefix(name: string): string {
  return `**${name}**\n`;
}

// --- Generating ------------------------------------------------------------------------------

/**
 * One reply from DeepSeek for `character`, cleaned for posting. `text` is null when the reply was
 * dropped by the safety filter. Throws when DeepSeek failed.
 */
export async function generateCharacterReply(input: {
  character: CharacterRecord;
  guildName: string;
  config: CharactersConfig;
  history: DeepSeekMessage[];
  userName?: string;
}): Promise<{ text: string | null; usage: DeepSeekUsage }> {
  const { character, config } = input;
  const system = buildCharacterPrompt(character, input.guildName, { maxReplyChars: config.max_reply_chars });
  const result = await chatCompletion({
    messages: buildChatMessages(system, character.greeting, input.history, character.name),
    maxTokens: maxTokensFor(character.replyStyle, config.max_reply_chars),
    temperature: character.temperature,
  });
  const text = sanitizeCharacterReply(result.text, {
    maxChars: config.max_reply_chars,
    characterName: character.name,
    userName: input.userName,
  });
  return { text, usage: result.usage };
}

// --- Reading the channel back ------------------------------------------------------------------

function readableText(message: Message): string {
  let text = message.content ?? "";
  text = text.replace(/<@!?(\d{15,25})>/g, (raw, id: string) => {
    const member = message.mentions.members?.get(id);
    const user = message.mentions.users.get(id);
    return member ? `@${member.displayName}` : user ? `@${user.displayName ?? user.username}` : raw;
  });
  text = text.replace(/<@&(\d{15,25})>/g, (raw, id: string) => {
    const role = message.guild?.roles.cache.get(id);
    return role ? `@${role.name}` : raw;
  });
  const parts = [text.trim()];
  for (const embed of message.embeds) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
  }
  if (message.stickers.size) parts.push(`[sticker: ${[...message.stickers.values()].map((s) => s.name).join(", ")}]`);
  if (message.attachments.size) parts.push(`[${message.attachments.size} attachment(s)]`);
  return parts.filter(Boolean).join("\n").trim();
}

/** Whether `message` is this character's own post (webhook, or the fallback bot message). */
export function isCharacterMessage(message: Message, character: Pick<CharacterRecord, "name">, ownWebhookId: string | null): boolean {
  if (message.webhookId) {
    return (message.webhookId === ownWebhookId || isOwnWebhookId(message.webhookId)) && message.author.username === character.name;
  }
  return message.author.id === message.client.user?.id && (message.content ?? "").startsWith(fallbackPrefix(character.name));
}

async function readHistory(
  message: Message,
  character: CharacterRecord,
  config: CharactersConfig,
  owned: OwnedWebhook | null,
): Promise<DeepSeekMessage[]> {
  const fetched = await message.channel.messages.fetch({ limit: 30 }).catch(() => null);
  const list = fetched ? [...fetched.values()].reverse() : [message];
  if (!list.some((m) => m.id === message.id)) list.push(message);
  const ownId = owned?.webhook.id ?? null;
  const selfIds = new Set(list.filter((m) => isCharacterMessage(m, character, ownId)).map((m) => m.id));

  const history: HistoryMessage[] = list.map((m) => {
    const self = selfIds.has(m.id);
    let kind: HistoryMessage["kind"];
    if (self) kind = "self";
    else if (m.webhookId && (m.webhookId === ownId || isOwnWebhookId(m.webhookId))) kind = "other_character";
    else if (m.author.bot || m.webhookId || m.system) kind = "bot";
    else kind = "member";
    let content = readableText(m);
    if (self && !m.webhookId) content = content.slice(fallbackPrefix(character.name).length);
    return {
      id: m.id,
      createdAt: m.createdTimestamp,
      kind,
      authorName: m.member?.displayName ?? m.author.displayName ?? m.author.username,
      content,
      repliesToSelf: Boolean(m.reference?.messageId && selfIds.has(m.reference.messageId)),
    };
  });

  const reset = getMemoryReset(character.id, message.channel.id);
  return buildHistory(history, {
    resetAt: reset?.getTime() ?? null,
    skipTexts: [typingTextFor(config, character.name), FAIL_TEXT],
  });
}

// --- Posting -------------------------------------------------------------------------------------

type Placeholder = {
  /** Replaces the typing text with the reply. False when that edit failed. */
  finish: (text: string) => Promise<boolean>;
  fail: () => Promise<void>;
  url: string | null;
};

async function sendViaWebhook(
  channel: GuildTextBasedChannel,
  character: CharacterRecord,
  content: string,
): Promise<{ owned: OwnedWebhook; message: Message } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const owned = await getOwnedWebhook(channel, CHARACTERS_WEBHOOK_NAME, "Dreamliner characters talk through this webhook");
    if (!owned) return null;
    try {
      const sent = await owned.webhook.send({
        content,
        username: character.name,
        avatarURL: characterAvatarUrl(character.guildId, character) ?? undefined,
        threadId: owned.threadId,
        allowedMentions: { parse: [] },
      });
      return { owned, message: sent as Message };
    } catch (err) {
      if (isUnknownWebhookError(err)) {
        invalidateOwnedWebhook(owned.channelId, CHARACTERS_WEBHOOK_NAME);
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function postPlaceholder(message: Message, character: CharacterRecord, config: CharactersConfig): Promise<Placeholder | null> {
  const channel = message.channel as GuildTextBasedChannel;
  const typing = typingTextFor(config, character.name);
  const replyLine = `${REPLY_CONTEXT_PREFIX} replying to <@${message.author.id}>\n`;

  const viaWebhook = await sendViaWebhook(channel, character, typing).catch((err) => {
    log.warn(`Character webhook send failed in ${message.guildId}/${channel.id}: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  if (viaWebhook) {
    const { owned, message: sent } = viaWebhook;
    const edit = (content: string) =>
      owned.webhook.editMessage(sent.id, { content, threadId: owned.threadId, allowedMentions: { parse: [] } });
    return {
      url: sent.url ?? null,
      finish: async (text) => edit(`${replyLine}${text}`).then(() => true, () => false),
      fail: async () => {
        await edit(FAIL_TEXT).catch(() => owned.webhook.deleteMessage(sent.id, owned.threadId).catch(() => null));
      },
    };
  }

  // No Manage Webhooks: a normal bot reply that names the character (the dashboard flags this).
  const me = message.guild?.members.me;
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) return null;
  const sent = await message
    .reply({ content: `${fallbackPrefix(character.name)}${typing}`, allowedMentions: { parse: [], repliedUser: false } })
    .catch(() => null);
  if (!sent) return null;
  return {
    url: sent.url,
    finish: async (text) =>
      sent.edit({ content: `${fallbackPrefix(character.name)}${text}`, allowedMentions: { parse: [], repliedUser: false } }).then(
        () => true,
        () => false,
      ),
    fail: async () => {
      await sent.delete().catch(() => null);
    },
  };
}

/** Posts `text` as the character (the greeting): webhook, or a plain bot message as fallback. */
export async function postAsCharacter(channel: GuildTextBasedChannel, character: CharacterRecord, text: string): Promise<string | null> {
  const viaWebhook = await sendViaWebhook(channel, character, text);
  if (viaWebhook) return viaWebhook.message.url ?? null;
  const sent = await channel.send({ content: `${fallbackPrefix(character.name)}${text}`, allowedMentions: { parse: [] } });
  return sent.url;
}

// --- Limit notes -------------------------------------------------------------------------------

const noteSent = new Map<string, number>();
const NOTE_EVERY_MS = 30 * 60_000;

/** A short note (deleted after a while) when a reply was refused for a limit. Throttled. */
export async function postLimitNote(message: Message, kind: "server" | "member", characterName: string): Promise<void> {
  const key = kind === "server" ? `${message.guildId}:${message.channelId}:server` : `${message.guildId}:${message.author.id}:member`;
  const last = noteSent.get(key);
  if (last && Date.now() - last < NOTE_EVERY_MS) return;
  noteSent.set(key, Date.now());
  capMap(noteSent, 5000);
  const text =
    kind === "server"
      ? `-# ${characterName} needs a rest: this server has used all of today's character replies. They'll be back after midnight UTC.`
      : `-# You've had all your character replies for today. Try again after midnight UTC.`;
  const sent = await message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
  if (sent) setTimeout(() => void sent.delete().catch(() => null), 20_000).unref?.();
}

// --- Lazy AI review: characters saved while DeepSeek wasn't configured ----------------------

const reviewing = new Set<number>();

async function ensureReviewed(character: CharacterRecord): Promise<CharacterRecord | null> {
  if (character.reviewedAt) return character;
  if (reviewing.has(character.id)) return null;
  reviewing.add(character.id);
  try {
    const verdict = await reviewCharacter(character);
    const updated = updateCharacter(character.guildId, character.id, {
      reviewStatus: verdict.approved ? "approved" : "rejected",
      reviewReason: verdict.approved ? null : verdict.reason,
      reviewedAt: verdict.aiReviewed ? new Date() : null,
      ...(verdict.approved ? {} : { enabled: false }),
    });
    return updated && updated.reviewStatus === "approved" ? updated : null;
  } catch (err) {
    if (!(err instanceof ReviewUnavailableError)) throw err;
    log.warn(`Couldn't review character ${character.id} before its first reply: ${err.message}`);
    return null;
  } finally {
    reviewing.delete(character.id);
  }
}

// --- The turn -------------------------------------------------------------------------------------

/** One reply from one character to the latest message(s) in a channel. */
export async function runCharacterTurn(_client: Client, message: Message, characterId: number): Promise<void> {
  const guild = message.guild as Guild | null;
  if (!guild || !isDeepSeekConfigured()) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, PLUGIN)) return;
  const config = charactersConfigOf(guildConfig);
  let character = getCharacter(guild.id, characterId);
  if (!character || !character.enabled || character.reviewStatus !== "approved") return;
  character = await ensureReviewed(character);
  if (!character) return;

  const oneActive = await guildHasOne(guild.id);
  if (!takeReply(guild.id, oneActive)) {
    await postLimitNote(message, "server", character.name);
    return;
  }

  let placeholder: Placeholder | null = null;
  try {
    const owned = await getOwnedWebhook(message.channel, CHARACTERS_WEBHOOK_NAME, "Dreamliner characters talk through this webhook");
    const history = await readHistory(message, character, config, owned);
    placeholder = await postPlaceholder(message, character, config);
    if (!placeholder) {
      refundReply(guild.id);
      return;
    }
    const { text, usage } = await generateCharacterReply({
      character,
      guildName: guild.name,
      config,
      history,
      userName: message.member?.displayName ?? message.author.displayName,
    });
    addTokens(guild.id, usage.input, usage.output);
    if (!text || !(await placeholder.finish(text))) {
      await placeholder.fail();
      refundReply(guild.id);
      return;
    }
    noteMemberReply(guild.id, message.author.id, character.id);
  } catch (err) {
    log.warn(`Character ${characterId} couldn't reply in ${guild.id}/${message.channelId}: ${err instanceof Error ? err.message : err}`);
    await placeholder?.fail().catch(() => null);
    refundReply(guild.id);
  }
}

// --- Scheduling: one reply per channel and character at a time, bursts batched ---------------

const DEBOUNCE_MS = 1500;
const pending = new Map<string, { timer: NodeJS.Timeout; message: Message }>();
const running = new Set<string>();
const rerun = new Map<string, Message>();

function turnKey(channelId: string, characterId: number): string {
  return `${channelId}:${characterId}`;
}

export function hasPendingTurn(channelId: string, characterId: number): boolean {
  const key = turnKey(channelId, characterId);
  return pending.has(key) || running.has(key);
}

/** Queues a reply from `characterId` to `message`, batching a quick burst into one reply. */
export function scheduleCharacterTurn(client: Client, message: Message, characterId: number): void {
  const key = turnKey(message.channelId, characterId);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const entry = pending.get(key);
    pending.delete(key);
    if (!entry) return;
    if (running.has(key)) {
      rerun.set(key, entry.message);
      return;
    }
    void runLocked(client, key, entry.message, characterId);
  }, DEBOUNCE_MS);
  pending.set(key, { timer, message });
}

async function runLocked(client: Client, key: string, message: Message, characterId: number): Promise<void> {
  running.add(key);
  try {
    await runCharacterTurn(client, message, characterId);
  } catch (err) {
    log.error(`Character turn failed (${key}):`, err);
  } finally {
    running.delete(key);
    const next = rerun.get(key);
    if (next) {
      rerun.delete(key);
      void runLocked(client, key, next, characterId);
    }
  }
}
