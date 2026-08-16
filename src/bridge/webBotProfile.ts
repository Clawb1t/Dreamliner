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
  markReviewMessageCancelled,
  submitBrandImageForReview,
} from "../plugins/bot_customisation/functions/review.js";
import {
  cancelBotBrandRequestById,
  DASHBOARD_REQUEST_CHANNEL,
  getBotAvatarRequest,
  getLatestApprovedBrandRequest,
  getStoredBotBio,
  getStoredBotNameStyle,
  getStoredBrandImage,
  listPendingBotBrandRequests,
  listRecentBotBrandRequests,
  setStoredBotBio,
  setStoredBotNameStyle,
  setStoredBrandImage,
  type BotAvatarRequest,
  type BotBrandImageKind,
} from "../plugins/bot_customisation/functions/store.js";
import { DREAMLINER_ONE_REQUIRED, isDreamlinerOneActive } from "./dreamlinerOne.js";

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

async function assertPluginEnabled(
  configManager: ConfigManager,
  guildId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "bot_customisation")) {
    return {
      ok: false,
      error: "The bot customisation plugin is disabled for this server.",
      status: 403,
    };
  }
  return { ok: true };
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

export async function getBridgeBotProfile(
  client: Client,
  configManager: ConfigManager,
  guild: Guild,
): Promise<{ ok: true; profile: BridgeBotProfile } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guild.id);
  const enabled = plugin.ok;

  // Gateway member payloads omit guild banners; REST fetch includes them.
  const me =
    (await guild.members.fetchMe({ force: true }).catch(() => null)) ??
    guild.members.me ??
    (client.user ? await guild.members.fetch({ user: client.user.id, force: true }).catch(() => null) : null);

  const pending = enabled ? await listPendingBotBrandRequests(guild.id) : [];
  const recent = enabled ? await listRecentBotBrandRequests(guild.id, 12) : [];
  const bio = enabled ? await getStoredBotBio(guild.id) : null;
  const hashes = await fetchMemberAssetHashes(client, guild, me);
  const displayNameStyle =
    (await fetchMemberDisplayNameStyle(client, guild)) ??
    (enabled ? await getStoredBotNameStyle(guild.id) : null);
  const appliedAvatarPng = enabled ? await resolveAppliedBrandPng(guild.id, "avatar") : null;
  const appliedBannerPng = enabled ? await resolveAppliedBrandPng(guild.id, "banner") : null;
  const appliedAvatar = enabled && appliedAvatarPng ? await getLatestApprovedBrandRequest(guild.id, "avatar") : null;
  const appliedBanner = enabled && appliedBannerPng ? await getLatestApprovedBrandRequest(guild.id, "banner") : null;
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
      nick: me?.nickname ?? null,
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
  configManager: ConfigManager,
  guild: Guild,
  kind: BotBrandImageKind,
): Promise<{ ok: true; body: Buffer; contentType: string } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guild.id);
  if (!plugin.ok) return plugin;

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
  configManager: ConfigManager,
  guildId: string,
  requestId: number,
): Promise<{ ok: true; png: Buffer; kind: BotBrandImageKind } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

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

export async function submitBridgeBrandImage(
  client: Client,
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  kind: BotBrandImageKind,
  imageBase64: string,
): Promise<
  | { ok: true; request: BridgeBotBrandRequest; reviewPosted: boolean }
  | { ok: false; error: string; status: number }
> {
  const plugin = await assertPluginEnabled(configManager, guild.id);
  if (!plugin.ok) return plugin;
  const one = await assertDreamlinerOne(guild.id);
  if (!one.ok) return one;

  const existing = (await listPendingBotBrandRequests(guild.id)).find((row) => row.kind === kind);
  if (existing) {
    return {
      ok: false,
      error: `This server already has a pending ${kind} request (#${existing.id}). Cancel it before submitting a new one.`,
      status: 409,
    };
  }

  const normalized = await normalizeBrandImageBase64(imageBase64, kind);
  if (!normalized.ok) {
    return { ok: false, error: `${normalized.title}: ${normalized.details}`, status: 400 };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  const requesterTag = member?.user.tag ?? userId;

  try {
    const { request, reviewPosted } = await submitBrandImageForReview({
      client,
      guildId: guild.id,
      guildName: guild.name,
      requesterId: userId,
      requesterTag,
      requestChannelId: DASHBOARD_REQUEST_CHANNEL,
      imagePng: normalized.buffer,
      kind,
    });
    return {
      ok: true,
      request: serializeRequest(guild.id, request),
      reviewPosted,
    };
  } catch (error) {
    return {
      ok: false,
      error: apiErrorMessage(error, `Failed to queue ${kind} for review.`),
      status: 500,
    };
  }
}

export async function cancelBridgeBrandRequest(
  client: Client,
  configManager: ConfigManager,
  guildId: string,
  requestId: number,
  userId: string,
): Promise<{ ok: true; request: BridgeBotBrandRequest } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const cancelled = await cancelBotBrandRequestById(requestId, guildId, userId);
  if (!cancelled) {
    return { ok: false, error: "No pending request with that id.", status: 404 };
  }

  await markReviewMessageCancelled(client, cancelled, userId);
  return { ok: true, request: serializeRequest(guildId, cancelled) };
}

export async function clearBridgeBrandImage(
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  kind: BotBrandImageKind,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guild.id);
  if (!plugin.ok) return plugin;
  const one = await assertDreamlinerOne(guild.id);
  if (!one.ok) return one;

  const member = await guild.members.fetch(userId).catch(() => null);
  const tag = member?.user.tag ?? userId;

  try {
    await guild.members.editMe({
      ...(kind === "banner" ? { banner: null } : { avatar: null }),
      reason: `Guild ${kind} cleared from dashboard by ${tag}`,
    });
    await setStoredBrandImage(guild.id, kind, "", userId);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: apiErrorMessage(error, `Discord rejected clearing the ${kind}.`),
      status: 400,
    };
  }
}

export async function setBridgeBotNickname(
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  nickname: string | null,
): Promise<{ ok: true; nick: string | null } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guild.id);
  if (!plugin.ok) return plugin;
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

  const member = await guild.members.fetch(userId).catch(() => null);
  const tag = member?.user.tag ?? userId;

  try {
    await guild.members.editMe({
      nick: next,
      reason: `Guild nickname ${next ? "set" : "cleared"} from dashboard by ${tag}`,
    });
    return { ok: true, nick: next };
  } catch (error) {
    return {
      ok: false,
      error: apiErrorMessage(error, "Discord rejected the nickname change."),
      status: 400,
    };
  }
}

export async function setBridgeBotBio(
  configManager: ConfigManager,
  guild: Guild,
  userId: string,
  bio: string | null,
): Promise<{ ok: true; bio: string | null } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guild.id);
  if (!plugin.ok) return plugin;
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

  const member = await guild.members.fetch(userId).catch(() => null);
  const tag = member?.user.tag ?? userId;

  try {
    await guild.members.editMe({
      bio: next,
      reason: `Guild bio ${next ? "set" : "cleared"} from dashboard by ${tag}`,
    });
    await setStoredBotBio(guild.id, next, userId);
    return { ok: true, bio: next };
  } catch (error) {
    return {
      ok: false,
      error: apiErrorMessage(error, "Discord rejected the bio change."),
      status: 400,
    };
  }
}

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
  const plugin = await assertPluginEnabled(configManager, guild.id);
  if (!plugin.ok) return plugin;
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

  const member = await guild.members.fetch(userId).catch(() => null);
  const tag = member?.user.tag ?? userId;

  try {
    const updated = await client.rest.patch(Routes.guildMember(guild.id, "@me"), {
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
      reason: `Guild display name style ${style ? "set" : "cleared"} from dashboard by ${tag}`,
    });
    // Discord echoes the applied style; keep it so the dashboard survives an incomplete read.
    const applied = style ? (parseDisplayNameStyle(updated) ?? style) : null;
    await setStoredBotNameStyle(guild.id, applied, userId);
    return { ok: true, displayNameStyle: applied };
  } catch (error) {
    return {
      ok: false,
      error: apiErrorMessage(error, "Discord rejected the display name style change."),
      status: 400,
    };
  }
}
