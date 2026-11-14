import { ChannelType, PermissionFlagsBits, type Guild, type GuildBasedChannel, type GuildMember } from "discord.js";
import { configManager } from "../../config/manager.js";
import { pluginEnabled } from "../pluginCommand.js";
import { permissionNames } from "../serverAutopilot/permissions.js";

/**
 * Read-only server checks for Avia, the help centre's AI assistant. Given a server the signed-in
 * user manages and the plugins they're asking about, it reports what's switched on, whether the
 * channels and roles those plugins point at still exist and whether Dreamliner can use them, plus the
 * dedicated health checks some plugins already have. Nothing here changes anything, and the report
 * never includes secrets (tokens, webhook URLs) or member data.
 */

export type AviaCheckStatus = "ok" | "warn" | "fail";
export type AviaCheck = { label: string; status: AviaCheckStatus; detail: string };

export type AviaPluginReport = {
  plugin: string;
  enabled: boolean;
  checks: AviaCheck[];
  /** A few plain settings (booleans, numbers, short strings) for context. */
  settings: Record<string, string | number | boolean>;
};

export type AviaDiagnostics = {
  server: { id: string; name: string; memberCount: number };
  dreamliner: {
    administrator: boolean;
    topRolePosition: number;
    /** Permissions that commonly matter, and whether Dreamliner has each. */
    keyPermissions: Record<string, boolean>;
    permissionCount: number;
  };
  enabledPlugins: string[];
  plugins: AviaPluginReport[];
};

/** A channel or role id a plugin's config points at, with the setting it came from. */
export type SnowflakeRef = { path: string; kind: "channel" | "role"; id: string };

const SNOWFLAKE = /^\d{17,20}$/;
const CHANNEL_KEY = /(?:^|_)(?:channel|category)(?:_id|_ids)$|^channels?$|(?:^|_)channels$/;
const ROLE_KEY = /(?:^|_)role(?:_id|_ids)$|^roles?$|(?:^|_)roles$/;
/** Settings that are never sent back, even though they're "plain" values. */
const SECRET_KEY = /token|secret|webhook|password|api_?key|url$/i;
const MAX_REFS = 40;
/** Plugins whose bridge already has a full health check (used instead of the generic walk). */
const DEDICATED_CHECKS = new Set(["passport", "appeals"]);
const MAX_SETTINGS = 14;

/**
 * Every channel/role id in a plugin's config (nested objects and arrays included), with a readable
 * setting path. Only keys that name a channel or role are considered, so ids in other settings (a
 * user allowlist, a message id) are never mistaken for channels.
 */
export function collectSnowflakeRefs(config: unknown, limit = MAX_REFS): SnowflakeRef[] {
  const refs: SnowflakeRef[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, path: string[], kind: "channel" | "role" | null) => {
    if (refs.length >= limit || value == null) return;
    if (typeof value === "string") {
      const id = value.trim();
      if (kind && SNOWFLAKE.test(id)) {
        const key = `${kind}:${id}:${path.join(".")}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({ path: path.join("."), kind, id });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, kind ? path : [...path, String(index)], kind));
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // Overrides target a member/role/channel to grant permissions: not a channel the plugin uses.
        if (key === "overrides") continue;
        const childKind = CHANNEL_KEY.test(key) ? "channel" : ROLE_KEY.test(key) ? "role" : null;
        visit(child, [...path, key], childKind);
      }
    }
  };
  visit(config, [], null);
  return refs;
}

/** Top-level plain settings worth showing for context (no ids, no secrets, nothing long). */
export function plainSettings(config: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!config || typeof config !== "object") return out;
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_SETTINGS) break;
    if (key.startsWith("can_") || SECRET_KEY.test(key)) continue;
    if (CHANNEL_KEY.test(key) || ROLE_KEY.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    else if (typeof value === "string" && value.length <= 40 && !SNOWFLAKE.test(value)) out[key] = value;
  }
  return out;
}

const KEY_PERMISSIONS: Array<[string, bigint]> = [
  ["Manage Server", PermissionFlagsBits.ManageGuild],
  ["Manage Roles", PermissionFlagsBits.ManageRoles],
  ["Manage Channels", PermissionFlagsBits.ManageChannels],
  ["Manage Messages", PermissionFlagsBits.ManageMessages],
  ["Manage Webhooks", PermissionFlagsBits.ManageWebhooks],
  ["Moderate Members", PermissionFlagsBits.ModerateMembers],
  ["Kick Members", PermissionFlagsBits.KickMembers],
  ["Ban Members", PermissionFlagsBits.BanMembers],
  ["View Audit Log", PermissionFlagsBits.ViewAuditLog],
  ["Create Invite", PermissionFlagsBits.CreateInstantInvite],
  ["Embed Links", PermissionFlagsBits.EmbedLinks],
];

/** Readable setting path: "review.channel_id" → "review › channel". */
function settingLabel(path: string): string {
  return path
    .split(".")
    .map((part) => part.replace(/_ids?$/, "").replace(/_/g, " "))
    .join(" › ");
}

function cap(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function channelCheck(ref: SnowflakeRef, channel: GuildBasedChannel | undefined, me: GuildMember | null): AviaCheck {
  const label = settingLabel(ref.path);
  if (!channel) return { label, status: "fail", detail: "Points at a channel that no longer exists. Pick a new one." };
  const name = channel.type === ChannelType.GuildCategory ? `category ${cap(channel.name)}` : `#${cap(channel.name)}`;
  if (!me) return { label, status: "ok", detail: name };
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) return { label, status: "fail", detail: `${name}: Dreamliner can't see this channel.` };
  const textLike = channel.isTextBased() && channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice;
  if (textLike && !perms.has(PermissionFlagsBits.SendMessages)) {
    return { label, status: "warn", detail: `${name}: Dreamliner can see it but can't send messages there.` };
  }
  if (textLike && !perms.has(PermissionFlagsBits.EmbedLinks)) {
    return { label, status: "warn", detail: `${name}: Dreamliner can't embed links there, so its embeds won't show.` };
  }
  return { label, status: "ok", detail: `${name}: Dreamliner can see and post here.` };
}

function roleCheck(ref: SnowflakeRef, guild: Guild, me: GuildMember | null): AviaCheck {
  const label = settingLabel(ref.path);
  const role = guild.roles.cache.get(ref.id);
  if (!role) return { label, status: "fail", detail: "Points at a role that no longer exists. Pick a new one." };
  const name = role.id === guild.id ? "@everyone" : `@${cap(role.name)}`;
  if (role.managed) return { label, status: "warn", detail: `${name} is managed by an integration, so Dreamliner can't give or remove it.` };
  const top = me?.roles.highest.position ?? 0;
  if (me && role.id !== guild.id && role.position >= top) {
    return {
      label,
      status: "warn",
      detail: `${name} sits above Dreamliner's highest role, so Dreamliner can't give or remove it. Drag Dreamliner's role above it in Server Settings › Roles.`,
    };
  }
  return { label, status: "ok", detail: `${name} exists and sits below Dreamliner.` };
}

/** The plugins a guild can have, from its effective config (enabled or not). */
async function pluginSections(guildId: string) {
  const config = await configManager.getEffectiveConfig(guildId);
  return config as unknown as { plugins: Record<string, { enabled?: boolean; config?: unknown } | undefined> };
}

export async function runAviaDiagnostics(guild: Guild, requested: string[]): Promise<AviaDiagnostics> {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const perms = me?.permissions;
  const config = await pluginSections(guild.id);
  const known = Object.keys(config.plugins ?? {});
  const enabledPlugins = known.filter((name) => pluginEnabled(config, name)).sort();
  const wanted = [...new Set(requested.map((p) => p.trim().toLowerCase()))].filter((p) => known.includes(p)).slice(0, 4);

  const plugins: AviaPluginReport[] = [];
  for (const plugin of wanted) {
    const section = config.plugins[plugin];
    const pluginConfig = section?.config ?? {};
    const checks: AviaCheck[] = [];
    // Plugins with their own health check get that instead of the generic channel/role walk, so
    // the same problem isn't reported twice.
    if (!DEDICATED_CHECKS.has(plugin)) {
      for (const ref of collectSnowflakeRefs(pluginConfig)) {
        checks.push(ref.kind === "channel" ? channelCheck(ref, guild.channels.cache.get(ref.id), me) : roleCheck(ref, guild, me));
      }
    }
    if (plugin === "passport") {
      const { runPassportDiagnostics } = await import("../../bridge/webPassport.js");
      const result = await runPassportDiagnostics(guild).catch(() => null);
      for (const c of result?.checks ?? []) checks.push({ label: c.label, status: c.status, detail: c.detail });
    } else if (plugin === "appeals") {
      const { appealDiagnostics } = await import("../../bridge/webAppeals.js");
      const result = await appealDiagnostics(guild).catch(() => null);
      for (const c of result?.checks ?? []) checks.push({ label: c.label, status: c.ok ? "ok" : "fail", detail: c.detail });
    }
    plugins.push({ plugin, enabled: pluginEnabled(config, plugin), checks: checks.slice(0, 30), settings: plainSettings(pluginConfig) });
  }

  return {
    server: { id: guild.id, name: cap(guild.name, 80), memberCount: guild.memberCount },
    dreamliner: {
      administrator: Boolean(perms?.has(PermissionFlagsBits.Administrator)),
      topRolePosition: me?.roles.highest.position ?? 0,
      keyPermissions: Object.fromEntries(KEY_PERMISSIONS.map(([name, bit]) => [name, Boolean(perms?.has(bit))])),
      permissionCount: perms ? permissionNames(perms.bitfield).length : 0,
    },
    enabledPlugins,
    plugins,
  };
}
