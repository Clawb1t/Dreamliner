import {
  DiscordAPIError,
  PermissionFlagsBits,
  Routes,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import type { ConfigManager } from "../config/manager.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { normalizeBrandImageBase64 } from "../plugins/bot_customisation/functions/normalizeImage.js";
import {
  logBrandImageApplied,
  markReviewMessageCancelled,
} from "../plugins/bot_customisation/functions/review.js";
import {
  cancelBotBrandRequestById,
  createAppliedBotBrandRequest,
  DASHBOARD_REQUEST_CHANNEL,
  getBotAvatarRequest,
  getLatestApprovedBrandRequest,
  getStoredBotBio,
  getStoredBotNameStyle,
  getStoredBotNickname,
  getStoredBrandImage,
  listPendingBotBrandRequests,
  listRecentBotBrandRequests,
  setStoredBotBio,
  setStoredBotNameStyle,
  setStoredBotNickname,
  setStoredBrandImage,
  supersedePendingBotBrandRequests,
  type BotAvatarRequest,
  type BotBrandImageKind,
} from "../plugins/bot_customisation/functions/store.js";
import { DREAMLINER_ONE_REQUIRED, isDreamlinerOneActive } from "./dreamlinerOne.js";
import { getLogger } from "../core/logger.js";
const log = getLogger("bridge");

const MAX_NICKNAME_LENGTH = 32;
const MAX_BIO_LENGTH = 190;
/** Monkey Bars (13) through Journal (16) never render, so they are not offered. */
const DISPLAY_NAME_FONT_IDS = new Set([3, 4, 6, 7, 8, 10, 11, 12]);
/** Prism (7) and Gummy (8) are excluded alongside the fonts Discord fails to render. */
const DISPLAY_NAME_EFFECT_IDS = new Set([1, 2, 3, 4, 5, 6]);

export type BridgeDisplayNameStyle = {
  fontId: number;
  effectId: number;
  colors: number[];
};

export type BridgeBotBrandRequest = {
  id: number;
  kind: BotBrandImageKind;
  status: string;
  requesterId: string;
  reviewerId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  source: "dashboard" | "discord";
  previewPath: string;
};

export type BridgeBotProfile = {
  /** Whether Custom Branding is turned on — decides whether the fields below are actually
   *  live on Discord right now, or just the saved draft waiting to be applied. Editing is
   *  always allowed regardless of this flag. */
  enabled: boolean;
  nick: string | null;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  hasCustomAvatar: boolean;
  hasCustomBanner: boolean;
  /** Latest approved request, used when Discord omits the live banner/avatar hash. */
  appliedAvatarRequestId: number | null;
  appliedBannerRequestId: number | null;
  username: string | null;
  canChangeNickname: boolean;
  displayNameStyle: BridgeDisplayNameStyle | null;
  pending: BridgeBotBrandRequest[];
  recent: BridgeBotBrandRequest[];
};

function serializeRequest(guildId: string, row: BotAvatarRequest): BridgeBotBrandRequest {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    requesterId: row.requesterId,
    reviewerId: row.reviewerId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    source: row.requestChannelId === DASHBOARD_REQUEST_CHANNEL ? "dashboard" : "discord",
    previewPath: `/bridge/guilds/${guildId}/bot-profile/requests/${row.id}/image`,
  };
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50013) {
      return "Discord denied the change (missing permissions). Make sure Dreamliner can change its own nickname in this server.";
    }
    if (error.code === 50035) {
      return "Discord rejected that value. Check the nickname/bio length or image format.";
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/**
 * Whether Custom Branding is currently on for this guild — no longer a gate on editing (every
 * submit/clear/set function below always saves its draft regardless), just the signal that
 * decides whether a draft change also gets applied live to Discord right now.
 */
async function isBotCustomisationEnabled(configManager: ConfigManager, guildId: string): Promise<boolean> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return pluginEnabled(guildConfig, "bot_customisation");
}

async function assertDreamlinerOne(
  guildId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (await isDreamlinerOneActive(guildId)) return { ok: true };
  return { ok: false, error: DREAMLINER_ONE_REQUIRED, status: 403 };
}

function guildMemberAssetUrl(
  kind: "avatars" | "banners",
  guildId: string,
  userId: string,
  hash: string | null | undefined,
  size: number,
): string | null {
  if (!hash) return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/${kind}/${hash}.${ext}?size=${size}`;
}

function memberHash(me: GuildMember | null, key: "avatar" | "banner"): string | null {
  if (!me) return null;
  const value = (me as GuildMember & { avatar?: string | null; banner?: string | null })[key];
  return typeof value === "string" && value.length ? value : null;
}

async function fetchMemberAssetHashes(
  client: Client,
  guild: Guild,
  me: GuildMember | null,
): Promise<{ avatar: string | null; banner: string | null }> {
  const userId = me?.id ?? client.user?.id ?? "";
  let avatar = memberHash(me, "avatar");
  let banner = memberHash(me, "banner");
  if (!userId) return { avatar, banner };
  try {
    const raw = (await client.rest.get(Routes.guildMember(guild.id, userId))) as {
      avatar?: string | null;
      banner?: string | null;
    };
    if (typeof raw.avatar === "string" && raw.avatar.length) avatar = raw.avatar;
    if (typeof raw.banner === "string" && raw.banner.length) banner = raw.banner;
  } catch {
    // REST may omit guild banners on some payloads; stored PNG is the fallback.
  }
  return { avatar, banner };
}

/** Reads display_name_styles off a private guild member payload. */
function parseDisplayNameStyle(payload: unknown): BridgeDisplayNameStyle | null {
  const style = (
    payload as {
      display_name_styles?: { font_id?: unknown; effect_id?: unknown; colors?: unknown } | null;
    } | null
  )?.display_name_styles;
  if (!style || typeof style.font_id !== "number" || typeof style.effect_id !== "number") {
    return null;
  }
  const colors = Array.isArray(style.colors)
    ? style.colors.filter(
        (color): color is number =>
          typeof color === "number" && Number.isInteger(color) && color >= 0 && color <= 0xffffff,
      )
    : [];
  return { fontId: style.font_id, effectId: style.effect_id, colors };
}

/**
 * Only the private member object carries display_name_styles, and Discord serves
 * that from the current-user route rather than the regular guild member route.
 */
async function fetchMemberDisplayNameStyle(
  client: Client,
  guild: Guild,
): Promise<BridgeDisplayNameStyle | null> {
  try {
    return parseDisplayNameStyle(await client.rest.get(`/users/@me/guilds/${guild.id}/member`));
  } catch {
    return null;
  }
}

/** PATCHes the live display name style (or clears it with `style: null`). Returns Discord's
 * raw response so a caller that needs the echoed value (setBridgeBotDisplayNameStyle) can read
 * it back; callers that already trust the stored draft (apply/revert below) just await it. */
async function applyDisplayNameStyle(
  client: Client,
  guild: Guild,
  style: BridgeDisplayNameStyle | null,
  reason: string,
): Promise<unknown> {
  return client.rest.patch(Routes.guildMember(guild.id, "@me"), {
    body: style
      ? {
          display_name_font_id: style.fontId,
          display_name_effect_id: style.effectId,
          display_name_colors: style.colors,
        }
      : {
          display_name_font_id: null,
          display_name_effect_id: null,
          display_name_colors: null,
        },
    reason,
  });
}

/** Applied PNG, hydrating from the latest approval when we have never stored one. */
async function resolveAppliedBrandPng(
  guildId: string,
  kind: BotBrandImageKind,
): Promise<string | null> {
  const stored = await getStoredBrandImage(guildId, kind);
  if (stored.state === "cleared") return null;
  if (stored.state === "custom") return stored.png;
  const approved = await getLatestApprovedBrandRequest(guildId, kind);
  if (!approved) return null;
  await setStoredBrandImage(guildId, kind, approved.avatarPng, "hydrate");
  return approved.avatarPng;
}

/**
 * Applies every stored draft (avatar, banner, nickname, bio, display name style) live to
 * Discord's per-guild bot profile in one shot — used when Custom Branding gets turned on, so
 * whatever was configured while it was off (or before) shows up immediately. A field with no
 * draft is explicitly cleared too, so the live profile always ends up matching the draft exactly.
 */
async function applyStoredBrandToDiscord(client: Client, guild: Guild, reason: string): Promise<void> {
  const [storedAvatar, storedBanner, storedBio, storedNick, storedStyle] = await Promise.all([
    getStoredBrandImage(guild.id, "avatar"),
    getStoredBrandImage(guild.id, "banner"),
    getStoredBotBio(guild.id),
    getStoredBotNickname(guild.id),
    getStoredBotNameStyle(guild.id),
  ]);

  const avatar = storedAvatar.state === "custom" ? Buffer.from(storedAvatar.png, "base64") : null;
  const banner = storedBanner.state === "custom" ? Buffer.from(storedBanner.png, "base64") : null;

  await guild.members.editMe({ avatar, banner, bio: storedBio, nick: storedNick, reason });

  try {
    await applyDisplayNameStyle(client, guild, storedStyle, reason);
  } catch (error) {
    log.error("[bot_customisation] Failed to re-apply display name style on enable:", error);
  }
}

/**
 * Clears the live per-guild bot profile back to Discord's own default — used when Custom
 * Branding gets turned off. Stored drafts are left untouched, so turning it back on restores
 * exactly what was configured.
 */
async function revertBrandToDefault(client: Client, guild: Guild, reason: string): Promise<void> {
  await guild.members.editMe({ avatar: null, banner: null, bio: null, nick: null, reason });

  try {
    await applyDisplayNameStyle(client, guild, null, reason);
  } catch (error) {
    log.error("[bot_customisation] Failed to clear display name style on disable:", error);
  }
}

/**
 * Flips Custom Branding on/off and syncs the live Discord profile to match — the one place
 * that decides "does the live bot profile mirror the draft, or sit at Discord's default".
 */
export async function setBridgeBotCustomisationEnabled(
  client: Client,
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const saved = await configManager.setPluginEnabled(guild.id, "bot_customisation", enabled, userId);
  if (!saved.success) {
    return { ok: false, error: saved.errors.join(" ") || "Failed to save the enabled setting.", status: 400 };
  }

  const reason = `Custom Branding ${enabled ? "enabled" : "disabled"} from dashboard by ${userId}`;
  try {
    if (enabled) {
      await applyStoredBrandToDiscord(client, guild, reason);
    } else {
      await revertBrandToDefault(client, guild, reason);
    }
  } catch (error) {
    return {
      ok: false,
      error: apiErrorMessage(
        error,
        `Custom Branding is now ${enabled ? "on" : "off"}, but Discord rejected syncing the live profile.`,
      ),
      status: 400,
    };
  }

  return { ok: true };
}

export async function getBridgeBotProfile(
  client: Client,
  configManager: ConfigManager,
  guild: Guild,
): Promise<{ ok: true; profile: BridgeBotProfile } | { ok: false; error: string; status: number }> {
  const enabled = await isBotCustomisationEnabled(configManager, guild.id);

  // Gateway member payloads omit guild banners; REST fetch includes them.
  const me =
    (await guild.members.fetchMe({ force: true }).catch(() => null)) ??
    guild.members.me ??
    (client.user ? await guild.members.fetch({ user: client.user.id, force: true }).catch(() => null) : null);

  const [pending, recent, bio, storedNick, storedStyle, appliedAvatarPng, appliedBannerPng] = await Promise.all([
    listPendingBotBrandRequests(guild.id),
    listRecentBotBrandRequests(guild.id, 12),
    getStoredBotBio(guild.id),
    getStoredBotNickname(guild.id),
    getStoredBotNameStyle(guild.id),
    resolveAppliedBrandPng(guild.id, "avatar"),
    resolveAppliedBrandPng(guild.id, "banner"),
  ]);
  const hashes = await fetchMemberAssetHashes(client, guild, me);
  const displayNameStyle = (await fetchMemberDisplayNameStyle(client, guild)) ?? storedStyle;
  const appliedAvatar = appliedAvatarPng ? await getLatestApprovedBrandRequest(guild.id, "avatar") : null;
  const appliedBanner = appliedBannerPng ? await getLatestApprovedBrandRequest(guild.id, "banner") : null;
  const userId = me?.id ?? client.user?.id ?? "";
  const hasCustomAvatar = Boolean(hashes.avatar || appliedAvatarPng);
  const hasCustomBanner = Boolean(hashes.banner || appliedBannerPng);

  const avatarUrl =
    guildMemberAssetUrl("avatars", guild.id, userId, hashes.avatar, 256) ??
    me?.displayAvatarURL({ size: 256 }) ??
    client.user?.displayAvatarURL({ size: 256 }) ??
    null;
  const bannerUrl = guildMemberAssetUrl("banners", guild.id, userId, hashes.banner, 512);

  return {
    ok: true,
    profile: {
      enabled,
      nick: me?.nickname ?? storedNick,
      displayName: me?.displayName ?? client.user?.username ?? "Dreamliner",
      bio,
      avatarUrl,
      bannerUrl,
      hasCustomAvatar,
      hasCustomBanner,
      appliedAvatarRequestId: appliedAvatar?.id ?? null,
      appliedBannerRequestId: appliedBanner?.id ?? null,
      username: me?.user.username ?? client.user?.username ?? null,
      canChangeNickname: Boolean(me?.permissions.has(PermissionFlagsBits.ChangeNickname)),
      displayNameStyle,
      pending: pending.map((row) => serializeRequest(guild.id, row)),
      recent: recent.map((row) => serializeRequest(guild.id, row)),
    },
  };
}

export async function getBridgeLiveBrandImage(
  client: Client,
  guild: Guild,
  kind: BotBrandImageKind,
): Promise<{ ok: true; body: Buffer; contentType: string } | { ok: false; error: string; status: number }> {
  const me =
    (await guild.members.fetchMe({ force: true }).catch(() => null)) ??
    guild.members.me ??
    (client.user ? await guild.members.fetch({ user: client.user.id, force: true }).catch(() => null) : null);
  const hashes = await fetchMemberAssetHashes(client, guild, me);
  const userId = me?.id ?? client.user?.id ?? "";
  const hash = kind === "banner" ? hashes.banner : hashes.avatar;
  const cdnUrl = guildMemberAssetUrl(
    kind === "banner" ? "banners" : "avatars",
    guild.id,
    userId,
    hash,
    kind === "banner" ? 512 : 256,
  );

  if (cdnUrl) {
    try {
      const res = await fetch(cdnUrl);
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "image/png";
        return { ok: true, body: Buffer.from(await res.arrayBuffer()), contentType };
      }
    } catch {
      // Fall through to the stored PNG.
    }
  }

  const png = await resolveAppliedBrandPng(guild.id, kind);
  if (!png) {
    return { ok: false, error: `No custom ${kind} is set for this server.`, status: 404 };
  }
  return { ok: true, body: Buffer.from(png, "base64"), contentType: "image/png" };
}

export async function getBridgeBotBrandRequestImage(
  guildId: string,
  requestId: number,
): Promise<{ ok: true; png: Buffer; kind: BotBrandImageKind } | { ok: false; error: string; status: number }> {
  const request = await getBotAvatarRequest(requestId);
  if (!request || request.guildId !== guildId) {
    return { ok: false, error: "Request not found.", status: 404 };
  }

  return {
    ok: true,
    png: Buffer.from(request.avatarPng, "base64"),
    kind: request.kind,
  };
}

/**
 * Always saves the avatar/banner as the guild's draft; also applies it live (no staff approval
 * gate) and posts a photo-log message with a "Remove" button when Custom Branding is on. While
 * off, the draft is saved but nothing changes on Discord until it's turned on.
 */
export async function submitBridgeBrandImage(
  client: Client,
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  kind: BotBrandImageKind,
  imageBase64: string,
): Promise<
  | { ok: true; request: BridgeBotBrandRequest; reviewPosted: boolean; applied: boolean }
  | { ok: false; error: string; status: number }
> {
  const one = await assertDreamlinerOne(guild.id);
  if (!one.ok) return one;

  const normalized = await normalizeBrandImageBase64(imageBase64, kind);
  if (!normalized.ok) {
    return { ok: false, error: `${normalized.title}: ${normalized.details}`, status: 400 };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  const requesterTag = member?.user.tag ?? userId;
  const enabled = await isBotCustomisationEnabled(configManager, guild.id);

  if (enabled) {
    try {
      await guild.members.editMe({
        ...(kind === "banner" ? { banner: normalized.buffer } : { avatar: normalized.buffer }),
        reason: `Guild ${kind} set from dashboard by ${requesterTag}`,
      });
    } catch (error) {
      return {
        ok: false,
        error: apiErrorMessage(error, `Discord rejected the ${kind} change.`),
        status: 400,
      };
    }
  }

  const pngBase64 = normalized.buffer.toString("base64");
  await setStoredBrandImage(guild.id, kind, pngBase64, userId).catch(() => undefined);
  // Clear out any leftover pending row for this kind (e.g. from before immediate-apply
  // shipped) so the dashboard doesn't keep showing a stale "waiting on staff" state.
  await supersedePendingBotBrandRequests(guild.id, kind, userId).catch(() => undefined);

  const request = await createAppliedBotBrandRequest({
    guildId: guild.id,
    requesterId: userId,
    requestChannelId: DASHBOARD_REQUEST_CHANNEL,
    imagePngBase64: pngBase64,
    kind,
  });

  let logPosted = false;
  if (enabled) {
    try {
      const logged = await logBrandImageApplied({
        client,
        guildName: guild.name,
        requesterId: userId,
        requesterTag,
        request,
        imagePng: normalized.buffer,
        kind,
      });
      logPosted = logged.logPosted;
    } catch (error) {
      log.error(`[bot_customisation] Failed to post ${kind} photo log`, error);
    }
  }

  return {
    ok: true,
    request: serializeRequest(guild.id, request),
    reviewPosted: logPosted,
    applied: enabled,
  };
}

export async function cancelBridgeBrandRequest(
  client: Client,
  guildId: string,
  requestId: number,
  userId: string,
): Promise<{ ok: true; request: BridgeBotBrandRequest } | { ok: false; error: string; status: number }> {
  const cancelled = await cancelBotBrandRequestById(requestId, guildId, userId);
  if (!cancelled) {
    return { ok: false, error: "No pending request with that id.", status: 404 };
  }

  await markReviewMessageCancelled(client, cancelled, userId);
  return { ok: true, request: serializeRequest(guildId, cancelled) };
}

/** Always clears the stored draft; also clears it live when Custom Branding is on. */
export async function clearBridgeBrandImage(
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  kind: BotBrandImageKind,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const one = await assertDreamlinerOne(guild.id);
  if (!one.ok) return one;

  const enabled = await isBotCustomisationEnabled(configManager, guild.id);
  if (enabled) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const tag = member?.user.tag ?? userId;
    try {
      await guild.members.editMe({
        ...(kind === "banner" ? { banner: null } : { avatar: null }),
        reason: `Guild ${kind} cleared from dashboard by ${tag}`,
      });
    } catch (error) {
      return {
        ok: false,
        error: apiErrorMessage(error, `Discord rejected clearing the ${kind}.`),
        status: 400,
      };
    }
  }

  await setStoredBrandImage(guild.id, kind, "", userId);
  return { ok: true };
}

/** Always saves the nickname draft; also applies it live when Custom Branding is on. */
export async function setBridgeBotNickname(
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  nickname: string | null,
): Promise<{ ok: true; nick: string | null } | { ok: false; error: string; status: number }> {
  const one = await assertDreamlinerOne(guild.id);
  if (!one.ok) return one;

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return { ok: false, error: "Could not resolve Dreamliner as a member of this server.", status: 500 };
  }
  if (!me.permissions.has(PermissionFlagsBits.ChangeNickname)) {
    return {
      ok: false,
      error: "Dreamliner needs the Change Nickname permission in this server.",
      status: 400,
    };
  }

  let next: string | null = null;
  if (nickname != null) {
    const trimmed = nickname.trim();
    if (!trimmed) {
      return { ok: false, error: "Nickname cannot be empty. Pass null to clear it.", status: 400 };
    }
    if (trimmed.length > MAX_NICKNAME_LENGTH) {
      return {
        ok: false,
        error: `Nicknames can be at most ${MAX_NICKNAME_LENGTH} characters.`,
        status: 400,
      };
    }
    next = trimmed;
  }

  const enabled = await isBotCustomisationEnabled(configManager, guild.id);
  if (enabled) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const tag = member?.user.tag ?? userId;
    try {
      await guild.members.editMe({
        nick: next,
        reason: `Guild nickname ${next ? "set" : "cleared"} from dashboard by ${tag}`,
      });
    } catch (error) {
      return {
        ok: false,
        error: apiErrorMessage(error, "Discord rejected the nickname change."),
        status: 400,
      };
    }
  }

  await setStoredBotNickname(guild.id, next, userId);
  return { ok: true, nick: next };
}

/** Always saves the bio draft; also applies it live when Custom Branding is on. */
export async function setBridgeBotBio(
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  bio: string | null,
): Promise<{ ok: true; bio: string | null } | { ok: false; error: string; status: number }> {
  const one = await assertDreamlinerOne(guild.id);
  if (!one.ok) return one;

  let next: string | null = null;
  if (bio != null) {
    const trimmed = bio.trim();
    if (trimmed.length > MAX_BIO_LENGTH) {
      return {
        ok: false,
        error: `Bios can be at most ${MAX_BIO_LENGTH} characters.`,
        status: 400,
      };
    }
    next = trimmed.length ? trimmed : null;
  }

  const enabled = await isBotCustomisationEnabled(configManager, guild.id);
  if (enabled) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const tag = member?.user.tag ?? userId;
    try {
      await guild.members.editMe({
        bio: next,
        reason: `Guild bio ${next ? "set" : "cleared"} from dashboard by ${tag}`,
      });
    } catch (error) {
      return {
        ok: false,
        error: apiErrorMessage(error, "Discord rejected the bio change."),
        status: 400,
      };
    }
  }

  await setStoredBotBio(guild.id, next, userId);
  return { ok: true, bio: next };
}

/** Always saves the display name style draft; also applies it live when Custom Branding is on. */
export async function setBridgeBotDisplayNameStyle(
  client: Client,
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  style: BridgeDisplayNameStyle | null,
): Promise<
  | { ok: true; displayNameStyle: BridgeDisplayNameStyle | null }
  | { ok: false; error: string; status: number }
> {
  const one = await assertDreamlinerOne(guild.id);
  if (!one.ok) return one;

  if (style) {
    if (!DISPLAY_NAME_FONT_IDS.has(style.fontId)) {
      return { ok: false, error: "That display name font is not supported.", status: 400 };
    }
    if (!DISPLAY_NAME_EFFECT_IDS.has(style.effectId)) {
      return { ok: false, error: "That display name effect is not supported.", status: 400 };
    }
    if (
      style.colors.length < 1 ||
      style.colors.length > 2 ||
      style.colors.some(
        (color) => !Number.isInteger(color) || color < 0 || color > 0xffffff,
      )
    ) {
      return {
        ok: false,
        error: "Choose one or two valid hexadecimal display name colors.",
        status: 400,
      };
    }
  }

  const enabled = await isBotCustomisationEnabled(configManager, guild.id);
  let applied = style;
  if (enabled) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const tag = member?.user.tag ?? userId;
    try {
      const updated = await applyDisplayNameStyle(
        client,
        guild,
        style,
        `Guild display name style ${style ? "set" : "cleared"} from dashboard by ${tag}`,
      );
      // Discord echoes the applied style; keep it so the dashboard survives an incomplete read.
      applied = style ? (parseDisplayNameStyle(updated) ?? style) : null;
    } catch (error) {
      return {
        ok: false,
        error: apiErrorMessage(error, "Discord rejected the display name style change."),
        status: 400,
      };
    }
  }

  await setStoredBotNameStyle(guild.id, applied, userId);
  return { ok: true, displayNameStyle: applied };
}
