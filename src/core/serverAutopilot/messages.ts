/**
 * Server Autopilot starter messages: each template message becomes a Message Kit (folder
 * "Server Autopilot") and is sent to its channel. Role pickers get one toggle button per self role
 * of their group, limited to roles the bot may hand out (autoGrantableRoleIds).
 */
import type { Client, Guild } from "discord.js";
import { configManager } from "../../config/manager.js";
import { KIT_LIMITS, PLUGIN as KITS_PLUGIN } from "../../plugins/message_kits/functions/constants.js";
import { parseKitDocument, type KitDocument, type KitRow } from "../../plugins/message_kits/functions/document.js";
import { loadKitsRuntime, sendKitToTarget } from "../../plugins/message_kits/functions/send.js";
import { countKits, insertKit } from "../../plugins/message_kits/functions/store.js";
import { autoGrantableRoleIds } from "../roles.js";
import type { SAMessage, SARole } from "./types.js";

export const KIT_FOLDER = "Server Autopilot";

/** Replaces {#channel_key} and {@role_key} with real mentions (unknown keys become plain text). */
export function resolveMentions(text: string, channelId: (key: string) => string | null, roleId: (key: string) => string | null): string {
  return text
    .replace(/\{#([a-z0-9_-]{1,60})\}/g, (_m, key: string) => {
      const id = channelId(key);
      return id ? `<#${id}>` : `#${key.replace(/_/g, "-")}`;
    })
    .replace(/\{@([a-z0-9_-]{1,60})\}/g, (_m, key: string) => {
      const id = roleId(key);
      return id ? `<@&${id}>` : `@${key.replace(/_/g, " ")}`;
    });
}

/** Strips a leading/trailing emoji from a role name for a button label, keeping the emoji separately. */
export function buttonParts(name: string): { label: string; emoji: string } {
  const lead = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u.exec(name);
  if (lead) return { label: name.slice(lead[0].length).trim().slice(0, 80) || name.slice(0, 80), emoji: lead[1]! };
  const trail = /\s*(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)$/u.exec(name);
  if (trail) return { label: name.slice(0, trail.index).trim().slice(0, 80) || name.slice(0, 80), emoji: trail[1]! };
  return { label: name.slice(0, 80), emoji: "" };
}

/** The kit document for one starter message (pure apart from the ids passed in). */
export function starterDocument(message: SAMessage, body: string, roleButtons: Array<{ roleId: string; name: string }>): KitDocument {
  const rows: KitRow[] = [];
  const buttons = roleButtons.slice(0, 25);
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: "buttons",
      buttons: buttons.slice(i, i + 5).map((b, j) => {
        const parts = buttonParts(b.name);
        return {
          id: `role_${i + j + 1}`,
          label: parts.label,
          emoji: parts.emoji,
          style: "secondary",
          url: "",
          disabled: false,
          action: { type: "role", mode: "toggle", role_ids: [b.roleId], reply: "" },
        };
      }),
    });
  }
  const parsed = parseKitDocument({
    format: "classic",
    embeds: [{ title: message.title.slice(0, 256), description: body.slice(0, 4096), color: message.color }],
    rows,
  });
  if (!parsed.ok) throw new Error(parsed.issues[0]?.message ?? "The starter message isn't valid.");
  return parsed.document;
}

/** Creates and sends one starter message. Returns the jump URL-less summary. */
export async function postStarterMessage(input: {
  client: Client;
  guild: Guild;
  message: SAMessage;
  roles: SARole[];
  channelId: (key: string) => string | null;
  roleId: (key: string) => string | null;
  actor: string;
}): Promise<void> {
  const { client, guild, message } = input;
  const target = input.channelId(message.channel_key);
  if (!target) throw new Error("Its channel wasn't built.");
  if (countKits(guild.id) >= KIT_LIMITS.kits) throw new Error(`Message Kits is full (${KIT_LIMITS.kits} kits).`);

  let buttons: Array<{ roleId: string; name: string }> = [];
  if (message.kind === "role_picker") {
    const groupRoles = input.roles.filter((r) => r.self_assignable && r.group === message.role_group);
    const ids = groupRoles.map((r) => input.roleId(r.key)).filter((id): id is string => Boolean(id));
    const allowed = new Set(autoGrantableRoleIds(guild, ids));
    buttons = groupRoles
      .map((r) => ({ roleId: input.roleId(r.key) ?? "", name: guild.roles.cache.get(input.roleId(r.key) ?? "")?.name ?? r.name }))
      .filter((b) => allowed.has(b.roleId));
    if (!buttons.length) throw new Error("None of its roles can be handed out by Dreamliner.");
  }

  const body = resolveMentions(message.body, input.channelId, input.roleId);
  const document = starterDocument(message, body, buttons);

  // Role buttons only work while Message Kits is on.
  const runtime = await loadKitsRuntime(guild.id);
  if (!runtime.enabled) await configManager.setPluginEnabled(guild.id, KITS_PLUGIN, true, `system:server-autopilot:${input.actor}`);

  const now = new Date();
  const kit = insertKit({
    guildId: guild.id,
    name: message.title.slice(0, KIT_LIMITS.kitName) || "Starter message",
    folder: KIT_FOLDER,
    description: `Posted by Server Autopilot (${message.kind.replace(/_/g, " ")}).`.slice(0, KIT_LIMITS.description),
    document: JSON.stringify(document),
    createdBy: input.actor,
    updatedBy: input.actor,
    createdAt: now,
    updatedAt: now,
    note: "Server Autopilot",
  });
  await sendKitToTarget(client, guild, kit, { channelId: target, userId: input.actor, reason: "dashboard" });
}
