/**
 * The step catalog the dashboard builds its library and forms from: every action with its
 * fields, outputs, required permissions, and whether THIS user in THIS server can use it
 * (plugin on, permissions held). Dynamic choices (quizzes, ticket types) are filled in
 * from this guild only.
 */
import { PermissionFlagsBits, type Guild } from "discord.js";
import { missingActorPermissions, permissionLabel, type ActorInfo, type PermName } from "../../../core/actorPermissions.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { CONDITIONS } from "./conditions.js";
import type { CatalogField } from "./fields.js";
import { ACTIONS, CATEGORIES } from "./registry.js";
import { LIMITS } from "./types.js";
import { fillConfig } from "./validate.js";

export const VARIABLE_DOCS: { key: string; label: string; example: string; group: "user" | "server" | "channel" | "time" | "run" }[] = [
  { key: "user", label: "Person who ran it (username)", example: "coal", group: "user" },
  { key: "user.mention", label: "Person who ran it (mention)", example: "@coal", group: "user" },
  { key: "user.display_name", label: "Their display name", example: "Coal", group: "user" },
  { key: "user.id", label: "Their user ID", example: "123456789012345678", group: "user" },
  { key: "user.avatar_url", label: "Their avatar link", example: "https://cdn.discordapp.com/...", group: "user" },
  { key: "user.joined_at", label: "When they joined", example: "12 March 2025", group: "user" },
  { key: "user.created_at", label: "When their account was made", example: "4 June 2019", group: "user" },
  { key: "user.bot", label: "Whether they're a bot", example: "false", group: "user" },
  { key: "server", label: "Server name", example: "Dreamliner HQ", group: "server" },
  { key: "server.id", label: "Server ID", example: "123456789012345678", group: "server" },
  { key: "server.icon_url", label: "Server icon link", example: "https://cdn.discordapp.com/...", group: "server" },
  { key: "server.member_count", label: "Member count", example: "1,204", group: "server" },
  { key: "server.owner", label: "Server owner (mention)", example: "@owner", group: "server" },
  { key: "server.owner_id", label: "Server owner ID", example: "123456789012345678", group: "server" },
  { key: "server.boosts", label: "Boosts", example: "14", group: "server" },
  { key: "server.verification_level", label: "Verification level", example: "Medium", group: "server" },
  { key: "channel", label: "Channel it was used in (mention)", example: "#general", group: "channel" },
  { key: "channel.name", label: "Channel name", example: "general", group: "channel" },
  { key: "channel.id", label: "Channel ID", example: "123456789012345678", group: "channel" },
  { key: "time", label: "Time now (UTC)", example: "14:05 UTC", group: "time" },
  { key: "date", label: "Date today (UTC)", example: "2026-11-22", group: "time" },
  { key: "timestamp", label: "Now, in everyone's time zone", example: "22 November 2026 14:05", group: "time" },
  { key: "timestamp:R", label: "Now, relative", example: "just now", group: "time" },
  { key: "random:1-100", label: "Random number 1 to 100", example: "42", group: "run" },
  { key: "runs", label: "Times this command was used", example: "318", group: "run" },
  { key: "command", label: "Command name", example: "cat", group: "run" },
];

export type CatalogAction = {
  type: string;
  category: string;
  label: string;
  description: string;
  icon: string;
  block?: string;
  fields: CatalogField[];
  outputs: { key: string; label: string }[];
  defaults: Record<string, unknown>;
  summary: string;
  plugin?: string;
  pluginLabel?: string;
  builderPermissions: string[];
  runnerPermissions: string[];
  available: boolean;
  unavailableReason: string | null;
};

async function dynamicOptions(guild: Guild): Promise<Record<string, { value: string; label: string }[]>> {
  const out: Record<string, { value: string; label: string }[]> = { quiz: [], category: [] };
  try {
    const store = await import("../../quizzes/functions/store.js");
    out.quiz = store
      .listQuizzes(guild.id)
      .filter((q) => q.status === "published")
      .slice(0, 100)
      .map((q) => ({ value: String(q.id), label: q.title }));
  } catch {
    /* ignore */
  }
  try {
    const { configManager } = await import("../../../config/manager.js");
    const cfg = (await configManager.getEffectiveConfig(guild.id)) as unknown as { plugins?: { tickets?: { config?: { panels?: { id: string; name: string; enabled: boolean; categories: { id: string; label: string }[] }[] } } } };
    for (const panel of cfg.plugins?.tickets?.config?.panels ?? []) {
      if (!panel.enabled) continue;
      for (const c of panel.categories ?? []) out.category!.push({ value: `${panel.id}:${c.id}`, label: `${panel.name || "Panel"}: ${c.label || "Ticket"}` });
    }
  } catch {
    /* ignore */
  }
  return out;
}

export async function buildCatalog(guild: Guild, guildConfig: GuildConfig, actor: ActorInfo | null, oneActive: boolean) {
  const dynamic = await dynamicOptions(guild);
  const actions: CatalogAction[] = ACTIONS.map((def) => {
    const defaults = fillConfig(def, {});
    const builderPerms = def.builderPerms?.(defaults) ?? [];
    const missing = actor ? missingActorPermissions(actor, builderPerms as PermName[]) : builderPerms;
    let unavailableReason: string | null = null;
    if (def.plugin && !pluginEnabled(guildConfig, def.plugin)) unavailableReason = `Turn on the ${def.pluginLabel ?? def.plugin} plugin first.`;
    else if (missing.length) unavailableReason = `You need ${missing.map((p) => permissionLabel(p)).join(", ")} to use this step.`;
    const fields = def.fields.map((f) => (f.dynamic ? { ...f, options: dynamic[f.key] ?? [] } : f)).map(({ dynamic: _d, ...rest }) => rest);
    return {
      type: def.type,
      category: def.category,
      label: def.label,
      description: def.description,
      icon: def.icon,
      ...(def.block ? { block: def.block } : {}),
      fields,
      outputs: def.outputs,
      defaults,
      summary: def.summary,
      ...(def.plugin ? { plugin: def.plugin, pluginLabel: def.pluginLabel ?? def.plugin } : {}),
      builderPermissions: builderPerms.map((p) => permissionLabel(p)),
      runnerPermissions: (def.runnerPerms?.(defaults) ?? []).map((p) => permissionLabel(p)),
      available: unavailableReason === null,
      unavailableReason,
    };
  });
  return {
    categories: CATEGORIES,
    actions,
    conditions: CONDITIONS.map((c) => ({ type: c.type, label: c.label, description: c.description, fields: c.fields, defaults: c.defaults })),
    variables: VARIABLE_DOCS,
    permissions: Object.keys(PermissionFlagsBits).map((name) => ({ name, label: permissionLabel(name) })),
    limits: LIMITS,
    oneActive,
  };
}
