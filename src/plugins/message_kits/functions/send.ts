import {
  AttachmentBuilder,
  ChannelFlags,
  ChannelType,
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  type Channel,
  type Client,
  type ForumChannel,
  type Guild,
  type GuildMember,
  type MediaChannel,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type SendableChannels,
  type TextChannel,
  type User,
  type Webhook,
  type WebhookMessageCreateOptions,
  type WebhookMessageEditOptions,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { zMessageKitsConfig, type MessageKitsConfig } from "../../../config/schemas/messageKits.js";
import { buildResultEmbed } from "../../../core/embeds.js";
import { fetchGuildChannel, fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { capMap } from "../../../core/mapPrune.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { containerReply } from "../../../core/responses.js";
import { buildTemplateVars } from "../../../core/templates.js";
import { getOwnedWebhook, invalidateOwnedWebhook, isUnknownWebhookError, rememberOwnWebhook, webhookTarget } from "../../../core/webhooks.js";
import { readKitAsset } from "./assets.js";
import { KIT_WEBHOOK_NAME, PLUGIN } from "./constants.js";
import { assetIdOf, coerceKitDocument, defaultKitDocument, isHttpUrl, messageAssetIds, parseKitDocument, type KitDocument } from "./document.js";
import { KitRenderError, renderKit, renderText, timeVars, type RenderedKit } from "./render.js";
import { getAssets, insertPost, updatePost, type KitPostRecord, type KitRecord } from "./store.js";

const log = getLogger("message_kits");

/** Something the person sending can fix (a permission, a deleted asset, a closed DM). */
export class KitSendError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly path = "",
  ) {
    super(message);
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const parsedByGuildConfig = new WeakMap<GuildConfig, MessageKitsConfig>();

export function loadKitsConfig(guildConfig: GuildConfig): MessageKitsConfig {
  let parsed = parsedByGuildConfig.get(guildConfig);
  if (!parsed) {
    parsed = parsePluginConfig(zMessageKitsConfig, getPluginSettings(guildConfig, PLUGIN));
    parsedByGuildConfig.set(guildConfig, parsed);
  }
  return parsed;
}

export async function loadKitsRuntime(guildId: string): Promise<{ guildConfig: GuildConfig; config: MessageKitsConfig; enabled: boolean }> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return { guildConfig, config: loadKitsConfig(guildConfig), enabled: pluginEnabled(guildConfig, PLUGIN) };
}

/**
 * The kit's document, checked strictly: saved kits can be unfinished drafts, so everything that
 * actually posts (sends, schedules, test DMs, copy updates, reply-with-kit) goes through this.
 */
export function sendableDocumentOf(kit: Pick<KitRecord, "document">): KitDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(kit.document);
  } catch {
    throw new KitSendError("This kit couldn't be read. Open it on the dashboard and save it again.", 422);
  }
  const parsed = parseKitDocument(raw);
  if (!parsed.ok) {
    const first = parsed.issues[0];
    throw new KitSendError(`This kit isn't finished yet: ${first?.message ?? "fix it on the dashboard first."}`, 422, first?.path ?? "");
  }
  return parsed.document;
}

/** The stored document of a kit (defaults filled in), never throwing on old/odd rows. */
export function kitDocumentOf(kit: Pick<KitRecord, "document">): KitDocument {
  try {
    return coerceKitDocument(JSON.parse(kit.document)) ?? defaultKitDocument();
  } catch {
    return defaultKitDocument();
  }
}

// ── Errors ──────────────────────────────────────────────────────────────────

function apiCode(error: unknown): number | null {
  if (error instanceof DiscordAPIError) return typeof error.code === "number" ? error.code : null;
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : null;
}

export function isUnknownMessage(error: unknown): boolean {
  return apiCode(error) === 10008;
}

function isUnknownChannel(error: unknown): boolean {
  return apiCode(error) === 10003;
}

/** Discord's error → a sentence for the dashboard. */
export function describeDiscordError(error: unknown): string {
  if (error instanceof KitSendError || error instanceof KitRenderError) return error.message;
  switch (apiCode(error)) {
    case 10003:
      return "That channel no longer exists.";
    case 10008:
      return "That message no longer exists.";
    case 10015:
      return "The webhook this copy was sent with was deleted.";
    case 50001:
      return "Dreamliner can't see that channel.";
    case 50013:
      return "Dreamliner is missing a permission in that channel.";
    case 50007:
      return "Dreamliner can't DM you. Turn on direct messages from server members (Privacy Settings) and try again.";
    case 40005:
      return "The files are too large for Discord's upload limit.";
    case 40067:
      return "This forum needs a tag on new posts.";
    case 50083:
      return "That thread is archived.";
    case 30007:
      return "That channel already has the most webhooks Discord allows (15). Delete one in the channel settings.";
    case 50035: {
      const message = error instanceof Error ? error.message.replace(/^Invalid Form Body\s*/i, "").trim() : "";
      return `Discord rejected the message${message ? `: ${message.slice(0, 300)}` : "."}`;
    }
    default:
      return error instanceof Error && error.message ? error.message.slice(0, 300) : "Discord couldn't send that message.";
  }
}

// ── Placeholders ────────────────────────────────────────────────────────────

const USER_KEYS = ["user", "user_id", "user_name", "user_tag", "user_display", "username", "avatar_url"];

/** Placeholder values for a send: the server and channel, plus the person when replying to them. */
export function kitVars(guild: Guild, channel: Channel | null, person?: { user: User; member?: GuildMember | null }, now = new Date()) {
  const vars = buildTemplateVars({
    guild,
    channel: channel && "name" in channel && !channel.isDMBased() ? (channel as TextChannel) : null,
    user: person?.user ?? null,
    member: person?.member ?? null,
  });
  // No person: leave {user} and friends as written instead of blanking them.
  if (!person) for (const key of USER_KEYS) delete vars[key];
  const time = timeVars(now);
  return { vars: { ...vars, ...time.markdown }, plainVars: { ...vars, ...time.plain } };
}

// ── Preparing a message ─────────────────────────────────────────────────────

export type PreparedKit = RenderedKit & { files: AttachmentBuilder[] };

/** Renders a document with its uploaded files attached (each under a unique file name). */
export function prepareKitMessage(
  guild: Guild,
  kitId: number,
  doc: KitDocument,
  vars: { vars: Record<string, string>; plainVars: Record<string, string> },
  now = new Date(),
): PreparedKit {
  const ids = messageAssetIds(doc);
  const assets = new Map(getAssets(guild.id, ids).map((asset) => [asset.id, asset]));
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const id of ids) {
    const asset = assets.get(id);
    if (!asset) continue;
    let name = asset.filename;
    if (used.has(name.toLowerCase())) name = `${id.slice(0, 6)}_${name}`;
    used.add(name.toLowerCase());
    names.set(id, name);
  }
  const bytes = new Map<string, Buffer>();
  const rendered = renderKit(doc, {
    kitId,
    vars: vars.vars,
    plainVars: vars.plainVars,
    now,
    assetFile: (id) => {
      const name = names.get(id);
      if (!name) return null;
      const data = bytes.get(id) ?? readKitAsset(guild.id, id);
      if (!data) return null;
      bytes.set(id, data);
      return name;
    },
  });
  const files = rendered.assetIds.map((id) => new AttachmentBuilder(bytes.get(id)!, { name: names.get(id)! }));
  return { ...rendered, files };
}

// ── Targets and permissions ─────────────────────────────────────────────────

export type KitTarget = {
  /** The channel picked (a forum for new forum posts). */
  channel: Channel;
  /** Where the message lands when it isn't a new forum post. */
  sendable: SendableChannels | null;
  forum: ForumChannel | MediaChannel | null;
  channelId: string;
  threadId: string | null;
};

function channelLabel(channel: Channel): string {
  return "name" in channel && channel.name ? `#${channel.name}` : "that channel";
}

/** Resolves a dashboard target. Both ids must belong to this guild (and the thread to the channel). */
export async function resolveKitTarget(client: Client, guild: Guild, channelId: string, threadId?: string | null): Promise<KitTarget> {
  const channel = await fetchGuildChannel(client, guild.id, channelId);
  if (!channel) throw new KitSendError("That channel isn't in this server (or Dreamliner can't see it).", 404);
  if (threadId) {
    const thread = await fetchGuildChannel(client, guild.id, threadId);
    if (!thread?.isThread() || thread.parentId !== channel.id) throw new KitSendError("That thread isn't in the chosen channel.", 404);
    if (!thread.isSendable()) throw new KitSendError("Dreamliner can't post in that thread.");
    return { channel, sendable: thread, forum: null, channelId: channel.id, threadId: thread.id };
  }
  if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
    return { channel, sendable: null, forum: channel, channelId: channel.id, threadId: null };
  }
  if (channel.isThread()) {
    if (!channel.isSendable()) throw new KitSendError("Dreamliner can't post in that thread.");
    return { channel, sendable: channel, forum: null, channelId: channel.parentId ?? channel.id, threadId: channel.id };
  }
  if (!channel.isTextBased() || !channel.isSendable())
    throw new KitSendError("Kits can be sent to text, announcement, voice, forum and media channels, or threads.");
  return { channel, sendable: channel, forum: null, channelId: channel.id, threadId: null };
}

/** The permissions a send needs, as a readable error (or null when everything's there). */
export function missingSendPermission(guild: Guild, target: KitTarget, prepared: PreparedKit, mode: "bot" | "webhook"): string | null {
  const me = guild.members.me;
  if (!me) return "Dreamliner isn't fully connected to this server yet. Try again in a minute.";
  const where = target.sendable ?? target.forum!;
  const perms = "permissionsFor" in where ? (where as TextChannel).permissionsFor(me) : null;
  if (!perms) return `Dreamliner can't see ${channelLabel(where)}.`;
  const needs: [bigint, string][] = [[PermissionFlagsBits.ViewChannel, "View Channel"]];
  if (target.forum) needs.push([PermissionFlagsBits.SendMessages, "Create Posts"]);
  else if (target.sendable?.isThread()) needs.push([PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"]);
  else needs.push([PermissionFlagsBits.SendMessages, "Send Messages"]);
  if (mode === "bot" && prepared.format === "classic" && (prepared.body.embeds?.length ?? 0) > 0) needs.push([PermissionFlagsBits.EmbedLinks, "Embed Links"]);
  if (prepared.files.length > 0) needs.push([PermissionFlagsBits.AttachFiles, "Attach Files"]);
  if (mode === "webhook") needs.push([PermissionFlagsBits.ManageWebhooks, "Manage Webhooks"]);
  const missing = needs.filter(([bit]) => !perms.has(bit)).map(([, name]) => `**${name}**`);
  if (!missing.length) return null;
  return `Dreamliner needs ${missing.join(", ")} in ${channelLabel(where)}.`;
}

// ── Webhooks ────────────────────────────────────────────────────────────────

/** Webhooks found by id (for editing copies), cached for 10 minutes, at most 2000. */
const webhookById = new Map<string, { webhook: Webhook; at: number }>();
const WEBHOOK_CACHE_MS = 10 * 60_000;

async function findWebhook(channel: Channel, webhookId: string): Promise<Webhook | null> {
  const hit = webhookById.get(webhookId);
  if (hit && Date.now() - hit.at < WEBHOOK_CACHE_MS) return hit.webhook;
  const target = webhookTarget(channel);
  const me = target?.parent.guild.members.me;
  if (!target || !me) return null;
  if (!target.parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks))
    throw new KitSendError(`Dreamliner needs **Manage Webhooks** in ${channelLabel(channel)} to update copies sent with a custom identity.`);
  const hooks = await target.parent.fetchWebhooks().catch(() => null);
  // Only webhooks Dreamliner created: Discord also returns tokens for members' incoming webhooks.
  const webhook = hooks?.find((hook) => hook.id === webhookId && hook.owner?.id === me.id && Boolean(hook.token)) ?? null;
  if (!webhook) return null;
  rememberOwnWebhook(webhook.id);
  webhookById.set(webhookId, { webhook, at: Date.now() });
  capMap(webhookById, 2000);
  return webhook;
}

/**
 * The application-owned webhook for a send. A custom avatar from the asset library can't be a
 * per-message `avatar_url` (assets have no public link), so each such avatar gets its own webhook
 * whose own avatar is that image.
 */
async function webhookFor(guild: Guild, channel: Channel, doc: KitDocument): Promise<{ webhook: Webhook; avatarFromWebhook: boolean }> {
  const avatarAsset = assetIdOf(doc.identity.avatar_url);
  const name = avatarAsset ? `${KIT_WEBHOOK_NAME} ${avatarAsset.slice(0, 6)}` : KIT_WEBHOOK_NAME;
  const owned = await getOwnedWebhook(channel, name, "Message Kits: send with a custom identity");
  if (!owned) throw new KitSendError(`Dreamliner couldn't create a webhook in ${channelLabel(channel)}. Check it has **Manage Webhooks** there (channels can have 15 webhooks).`);
  if (avatarAsset && !owned.webhook.avatar) {
    const bytes = readKitAsset(guild.id, avatarAsset);
    if (!bytes) throw new KitSendError("The avatar image was deleted from the asset library. Pick another one.", 400, "identity.avatar_url");
    await owned.webhook.edit({ avatar: bytes, reason: "Message Kits avatar" }).catch((error) => {
      throw new KitSendError(`Couldn't set the webhook avatar: ${describeDiscordError(error)}`);
    });
  }
  return { webhook: owned.webhook, avatarFromWebhook: Boolean(avatarAsset) };
}

const RESERVED_NAME = /discord|clyde/i;

function identityFor(guild: Guild, doc: KitDocument, plainVars: Record<string, string>): { username: string; avatarURL?: string } {
  let username = renderText(doc.identity.name, plainVars).trim().slice(0, 80) || guild.name.slice(0, 80);
  if (RESERVED_NAME.test(username)) username = guild.client.user?.username ?? "Dreamliner";
  const rawAvatar = doc.identity.avatar_url.trim();
  if (assetIdOf(rawAvatar)) return { username };
  const rendered = renderText(rawAvatar, plainVars).trim();
  const avatarURL = rendered && isHttpUrl(rendered) ? rendered : (guild.iconURL({ extension: "png", size: 256 }) ?? guild.client.user?.displayAvatarURL({ extension: "png", size: 256 }));
  return { username, ...(avatarURL ? { avatarURL } : {}) };
}

// ── Sending ─────────────────────────────────────────────────────────────────

function createOptions(prepared: PreparedKit): MessageCreateOptions {
  return {
    ...prepared.body,
    files: prepared.files,
    flags: prepared.body.flags as MessageCreateOptions["flags"],
  } as MessageCreateOptions;
}

function threadTitle(kit: KitRecord, doc: KitDocument, plainVars: Record<string, string>): string {
  return (renderText(doc.thread_name, plainVars).trim() || kit.name).slice(0, 100) || "Message";
}

function forumTags(forum: ForumChannel | MediaChannel): string[] | undefined {
  // A forum that requires tags rejects untagged posts; the first tag is the best guess.
  if (!forum.flags.has(ChannelFlags.RequireTag)) return undefined;
  const tag = forum.availableTags.find((t) => !t.moderated) ?? forum.availableTags[0];
  return tag ? [tag.id] : undefined;
}

type Delivered = { message: Message; via: "bot" | "webhook"; webhookId: string | null; channelId: string; threadId: string | null };

async function deliver(guild: Guild, kit: KitRecord, doc: KitDocument, target: KitTarget, prepared: PreparedKit, plainVars: Record<string, string>): Promise<Delivered> {
  const mode = doc.identity.mode;
  const missing = missingSendPermission(guild, target, prepared, mode);
  if (missing) throw new KitSendError(missing, 403);

  if (mode === "webhook") {
    const where = target.forum ?? target.sendable!;
    const { webhook, avatarFromWebhook } = await webhookFor(guild, where, doc);
    const identity = identityFor(guild, doc, plainVars);
    const options: WebhookMessageCreateOptions = {
      ...(createOptions(prepared) as WebhookMessageCreateOptions),
      username: identity.username,
      ...(!avatarFromWebhook && identity.avatarURL ? { avatarURL: identity.avatarURL } : {}),
      // Application-owned webhooks may carry interactive components; this makes Discord honour them.
      withComponents: true,
    };
    if (target.threadId) options.threadId = target.threadId;
    if (target.forum) {
      options.threadName = threadTitle(kit, doc, plainVars);
      const tags = forumTags(target.forum);
      if (tags) options.appliedTags = tags;
    }
    let message: Message;
    try {
      message = await webhook.send(options);
    } catch (error) {
      if (isUnknownWebhookError(error)) invalidateOwnedWebhook(webhookTarget(where)?.parent.id ?? where.id, webhook.name);
      throw error;
    }
    const threadId = target.forum ? message.channelId : target.threadId;
    return { message, via: "webhook", webhookId: webhook.id, channelId: target.channelId, threadId };
  }

  if (target.forum) {
    const thread = await target.forum.threads.create({
      name: threadTitle(kit, doc, plainVars),
      message: createOptions(prepared) as Parameters<ForumChannel["threads"]["create"]>[0]["message"],
      appliedTags: forumTags(target.forum),
    });
    const message = await thread.fetchStarterMessage();
    if (!message) throw new KitSendError("The forum post was created, but its first message couldn't be read.");
    return { message, via: "bot", webhookId: null, channelId: target.channelId, threadId: thread.id };
  }
  const message = await target.sendable!.send(createOptions(prepared));
  return { message, via: "bot", webhookId: null, channelId: target.channelId, threadId: target.threadId };
}

/** Sends a kit to one target and records the copy. */
export async function sendKitToTarget(
  client: Client,
  guild: Guild,
  kit: KitRecord,
  input: { channelId: string; threadId?: string | null; userId: string | null; reason: "dashboard" | "schedule" },
): Promise<KitPostRecord> {
  const doc = sendableDocumentOf(kit);
  const target = await resolveKitTarget(client, guild, input.channelId, input.threadId);
  const now = new Date();
  const vars = kitVars(guild, target.sendable ?? target.channel, undefined, now);
  const prepared = prepareKitMessage(guild, kit.id, doc, vars, now);
  const delivered = await deliver(guild, kit, doc, target, prepared, vars.plainVars);
  const post = insertPost({
    guildId: guild.id,
    kitId: kit.id,
    channelId: delivered.channelId,
    threadId: delivered.threadId,
    messageId: delivered.message.id,
    via: delivered.via,
    webhookId: delivered.webhookId,
    format: prepared.format,
    kitVersion: kit.version,
    postedBy: input.userId,
    postedAt: now,
    lastSyncedAt: null,
    deletedAt: null,
  });
  void logKitEvent(
    client,
    guild,
    input.reason === "schedule" ? "Scheduled kit sent" : "Kit sent",
    `**${kit.name}** was sent to <#${delivered.threadId ?? delivered.channelId}>${input.userId && input.reason === "dashboard" ? ` by <@${input.userId}>` : ""}. [Jump](${delivered.message.url})`,
  );
  return post;
}

// ── Existing copies ─────────────────────────────────────────────────────────

/** The channel a copy lives in, or "gone" when Discord says it was deleted. */
async function postChannel(client: Client, guild: Guild, post: KitPostRecord): Promise<Channel | "gone"> {
  const id = post.threadId ?? post.channelId;
  const channel = await fetchGuildChannel(client, guild.id, id);
  if (channel) return channel;
  try {
    await guild.channels.fetch(id);
  } catch (error) {
    if (isUnknownChannel(error)) return "gone";
  }
  throw new KitSendError("Dreamliner can't see the channel this copy is in any more.");
}

export function postUrl(guildId: string, post: Pick<KitPostRecord, "channelId" | "threadId" | "messageId">): string {
  return `https://discord.com/channels/${guildId}/${post.threadId ?? post.channelId}/${post.messageId}`;
}

function markDeleted(post: KitPostRecord): KitPostRecord {
  return updatePost(post.id, { deletedAt: new Date() }) ?? { ...post, deletedAt: new Date() };
}

async function postWebhook(channel: Channel, post: KitPostRecord): Promise<Webhook> {
  const webhook = post.webhookId ? await findWebhook(channel, post.webhookId) : null;
  if (!webhook) throw new KitSendError("The webhook this copy was sent with was deleted, so it can't be edited. Delete the copy or send the kit again.");
  return webhook;
}

export type SyncOutcome = { ok: true; post: KitPostRecord; reposted: boolean } | { ok: false; post: KitPostRecord; error: string };

/**
 * Edits one copy to the kit's current version. A copy that can't become the new message by an
 * edit (V2 → classic, or a different identity mode) is sent again in the same place and the old
 * one deleted; the row then points at the new message.
 */
export async function syncPost(client: Client, guild: Guild, kit: KitRecord, post: KitPostRecord): Promise<SyncOutcome> {
  try {
    const doc = sendableDocumentOf(kit);
    const channel = await postChannel(client, guild, post);
    if (channel === "gone") return { ok: false, post: markDeleted(post), error: "The channel was deleted." };

    const needsRepost = (post.format === "v2" && doc.format === "classic") || post.via !== doc.identity.mode;
    if (needsRepost) return await repost(client, guild, kit, post, doc);

    const now = new Date();
    const vars = kitVars(guild, channel, undefined, now);
    const prepared = prepareKitMessage(guild, kit.id, doc, vars, now);
    if (prepared.files.length && "permissionsFor" in channel && guild.members.me) {
      const perms = (channel as TextChannel).permissionsFor(guild.members.me);
      if (perms && !perms.has(PermissionFlagsBits.AttachFiles)) throw new KitSendError(`Dreamliner needs **Attach Files** in ${channelLabel(channel)}.`, 403);
    }
    const toV2 = post.format === "classic" && prepared.format === "v2";
    const edit = {
      ...prepared.body,
      // Edits replace every attachment; V2 can't carry content or embeds.
      content: prepared.format === "v2" ? (toV2 ? "" : undefined) : (prepared.body.content ?? ""),
      embeds: prepared.format === "v2" ? (toV2 ? [] : undefined) : prepared.body.embeds,
      files: prepared.files,
      attachments: [],
      flags: (prepared.body.flags & (MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds)) as MessageEditOptions["flags"],
    };
    if (edit.content === undefined) delete edit.content;
    if (edit.embeds === undefined) delete edit.embeds;

    try {
      if (post.via === "webhook") {
        const webhook = await postWebhook(channel, post);
        await webhook.editMessage(post.messageId, {
          ...(edit as WebhookMessageEditOptions),
          ...(post.threadId ? { threadId: post.threadId } : {}),
          withComponents: true,
        });
      } else {
        if (!channel.isTextBased()) throw new KitSendError("That channel can't hold messages any more.");
        const message = await channel.messages.fetch(post.messageId);
        if (message.author.id !== client.user?.id) throw new KitSendError("Only messages sent by Dreamliner can be edited.");
        await message.edit(edit as MessageEditOptions);
      }
    } catch (error) {
      if (isUnknownMessage(error)) return { ok: false, post: markDeleted(post), error: "The message was deleted." };
      // Some classic → V2 edits are refused; sending it again gets the same result.
      if (toV2 && apiCode(error) === 50035) return await repost(client, guild, kit, post, doc);
      throw error;
    }
    const updated = updatePost(post.id, { kitVersion: kit.version, format: prepared.format, lastSyncedAt: now }) ?? post;
    void logKitEvent(client, guild, "Kit copy updated", `A copy of **${kit.name}** was updated to version ${kit.version}. [Jump](${postUrl(guild.id, updated)})`);
    return { ok: true, post: updated, reposted: false };
  } catch (error) {
    return { ok: false, post, error: describeDiscordError(error) };
  }
}

async function repost(client: Client, guild: Guild, kit: KitRecord, post: KitPostRecord, doc: KitDocument): Promise<SyncOutcome> {
  // Same place: the thread (or forum post) it was in, else the channel.
  const target = await resolveKitTarget(client, guild, post.channelId, post.threadId);
  const now = new Date();
  const vars = kitVars(guild, target.sendable ?? target.channel, undefined, now);
  const prepared = prepareKitMessage(guild, kit.id, doc, vars, now);
  const delivered = await deliver(guild, kit, doc, target, prepared, vars.plainVars);
  await deleteMessageOf(client, guild, post).catch(() => undefined);
  const updated =
    updatePost(post.id, {
      messageId: delivered.message.id,
      channelId: delivered.channelId,
      threadId: delivered.threadId,
      via: delivered.via,
      webhookId: delivered.webhookId,
      format: prepared.format,
      kitVersion: kit.version,
      lastSyncedAt: now,
      deletedAt: null,
    }) ?? post;
  void logKitEvent(client, guild, "Kit copy re-sent", `A copy of **${kit.name}** couldn't be edited into the new version, so it was sent again. [Jump](${delivered.message.url})`);
  return { ok: true, post: updated, reposted: true };
}

/** Deletes a copy's message on Discord (missing counts as deleted). */
async function deleteMessageOf(client: Client, guild: Guild, post: KitPostRecord): Promise<void> {
  const channel = await postChannel(client, guild, post);
  if (channel === "gone") return;
  try {
    if (post.via === "webhook") {
      const webhook = await postWebhook(channel, post);
      await webhook.deleteMessage(post.messageId, post.threadId ?? undefined);
    } else {
      if (!channel.isTextBased()) return;
      // A forum post we started: remove the whole post when allowed.
      if (channel.isThread() && post.messageId === channel.id && guild.members.me && channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageThreads)) {
        await channel.delete("Message Kits: copy deleted");
        return;
      }
      await channel.messages.delete(post.messageId);
    }
  } catch (error) {
    if (isUnknownMessage(error) || isUnknownChannel(error)) return;
    throw error;
  }
}

export async function deletePost(client: Client, guild: Guild, post: KitPostRecord, kitName: string | null): Promise<KitPostRecord> {
  if (!post.deletedAt) {
    try {
      await deleteMessageOf(client, guild, post);
    } catch (error) {
      throw new KitSendError(describeDiscordError(error));
    }
  }
  const updated = markDeleted(post);
  void logKitEvent(client, guild, "Kit copy deleted", `A copy${kitName ? ` of **${kitName}**` : ""} in <#${post.threadId ?? post.channelId}> was deleted.`);
  return updated;
}

/** Checks a copy still exists (marking it deleted when it doesn't). */
export async function refreshPost(client: Client, guild: Guild, post: KitPostRecord): Promise<KitPostRecord> {
  if (post.deletedAt) return post;
  const channel = await postChannel(client, guild, post).catch((error) => {
    throw new KitSendError(describeDiscordError(error));
  });
  if (channel === "gone") return markDeleted(post);
  try {
    if (post.via === "webhook") {
      const webhook = await postWebhook(channel, post);
      await webhook.fetchMessage(post.messageId, post.threadId ? { threadId: post.threadId } : {});
    } else if (channel.isTextBased()) {
      await channel.messages.fetch(post.messageId);
    }
  } catch (error) {
    if (isUnknownMessage(error)) return markDeleted(post);
    throw new KitSendError(describeDiscordError(error));
  }
  return post;
}

/** Runs `fn` over `items` with at most `limit` at once (rate-limit friendly syncs). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── DMs and logs ────────────────────────────────────────────────────────────

/** "Test send": the kit as the dashboard user would see it, in their DMs. */
export async function sendKitTest(client: Client, guild: Guild, kit: KitRecord, userId: string): Promise<void> {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) throw new KitSendError("Couldn't find your Discord account.", 404);
  const member = await guild.members.fetch(userId).catch(() => null);
  const doc = sendableDocumentOf(kit);
  const vars = kitVars(guild, null, { user, member });
  const prepared = prepareKitMessage(guild, kit.id, doc, vars);
  try {
    const dm = await user.createDM();
    await dm.send(createOptions(prepared));
  } catch (error) {
    throw new KitSendError(describeDiscordError(error));
  }
}

export async function logKitEvent(client: Client, guild: Guild, title: string, details: string): Promise<void> {
  try {
    const { config } = await loadKitsRuntime(guild.id);
    if (!config.log_channel_id) return;
    const channel = await fetchGuildTextChannel(client, guild.id, config.log_channel_id);
    if (!channel) return;
    await channel.send(containerReply(buildResultEmbed(title, `**Message Kits** · ${details}`, { client, tone: "neutral" })));
  } catch (error) {
    log.warn(`Could not write a Message Kits log entry in ${guild.id}: ${error instanceof Error ? error.message : error}`);
  }
}
