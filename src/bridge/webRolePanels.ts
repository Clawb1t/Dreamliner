import type { Client, Guild } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { zPersistEmbedConfig } from "../config/schemas/persist.js";
import { zRolePanel } from "../config/schemas/rolePanels.js";
import { renderTemplate } from "../core/templates.js";
import { parseMessageLink } from "../core/messageLink.js";
import { ROLE_PANEL_PREFIX } from "../plugins/role_panels/defaultOverrides.js";
import { buildEmbed } from "../plugins/persist/functions/messageBuilder.js";
import { buildRolePanelButtonRows } from "../plugins/role_panels/functions/messageBuilder.js";

function pickPreviewChannel(guild: Guild, channelId: unknown) {
  const requested = typeof channelId === "string" ? guild.channels.cache.get(channelId) : undefined;
  if (requested?.isTextBased() && !requested.isDMBased()) return requested;
  if (guild.systemChannel) return guild.systemChannel;
  return [...guild.channels.cache.values()].find((c) => c.isTextBased() && !c.isDMBased()) ?? null;
}

export type RolePanelPreviewRole = {
  roleId: string;
  roleName: string;
  roleColor: number;
  emoji: string;
  label: string;
  style: string;
};

export type RolePanelPreviewResponse = {
  ok: true;
  content: string;
  embed: Record<string, unknown> | null;
  roles: RolePanelPreviewRole[];
};

/** Lenient — the dashboard calls this on every keystroke, so a still-incomplete draft must still preview. */
export async function buildRolePanelPreview(
  client: Client,
  guild: Guild,
  body: { panel?: unknown },
): Promise<RolePanelPreviewResponse> {
  const raw = (body.panel && typeof body.panel === "object" ? body.panel : {}) as Record<string, unknown>;
  const content = typeof raw.content === "string" ? raw.content : "";
  const embedConfig = zPersistEmbedConfig.parse(raw.embed ?? {});
  const rolesRaw = Array.isArray(raw.roles) ? raw.roles.slice(0, 25) : [];

  const roles: RolePanelPreviewRole[] = rolesRaw.map((entry) => {
    const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const roleId = typeof row.role_id === "string" ? row.role_id : "";
    const liveRole = roleId ? guild.roles.cache.get(roleId) : undefined;
    const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : (liveRole?.name ?? "Role");
    return {
      roleId,
      roleName: liveRole?.name ?? (roleId ? "Unknown role" : ""),
      roleColor: liveRole?.color ?? 0,
      emoji: typeof row.emoji === "string" ? row.emoji : "",
      label,
      style: typeof row.style === "string" ? row.style : "secondary",
    };
  });

  const channel = pickPreviewChannel(guild, raw.channel_id);
  const renderedContent = renderTemplate(content, { guild, channel: channel as never, client } as never);

  let embedJson: Record<string, unknown> | null = null;
  if (channel) {
    const embedBuilder = buildEmbed(embedConfig, { client, guild, channel });
    embedJson = embedBuilder ? (embedBuilder.toJSON() as Record<string, unknown>) : null;
  }

  return { ok: true, content: renderedContent, embed: embedJson, roles };
}

export async function sendRolePanelTest(
  client: Client,
  guild: Guild,
  channelId: string,
  draftPanel: unknown,
): Promise<{ ok: boolean; detail: string }> {
  const parsed = zRolePanel.safeParse(draftPanel);
  if (!parsed.success) {
    return { ok: false, detail: parsed.error.issues.map((i) => i.message).join("; ") || "Invalid panel." };
  }
  const panel = parsed.data;
  if (panel.post_mode !== "bot") {
    return { ok: false, detail: "Nothing to test-send for an existing-message panel — use Validate instead." };
  }

  const channelRef = await guild.channels.fetch(channelId).catch(() => null);
  if (!channelRef?.isTextBased() || channelRef.isDMBased() || !("send" in channelRef)) {
    return { ok: false, detail: "That channel could not be found or the bot cannot send there." };
  }

  const { buildRolePanelPayload } = await import("../plugins/role_panels/functions/messageBuilder.js");
  const built = buildRolePanelPayload(panel, { client, guild, channel: channelRef });
  if (built.empty) {
    return { ok: false, detail: "This panel has no content to send yet." };
  }

  const sent = await channelRef.send(built.payload).catch((error) => {
    console.warn("[role_panels] test send failed:", error instanceof Error ? error.message : error);
    return null;
  });
  if (!sent) return { ok: false, detail: "Discord rejected the message — check the bot's permissions in that channel." };

  if (panel.trigger_type === "reaction") {
    for (const role of panel.roles) {
      await sent.react(role.emoji.trim()).catch(() => null);
    }
  }

  return {
    ok: true,
    detail: "Test message sent. This is a standalone message — it isn't tracked or auto-updated like a saved panel, so delete it manually when you're done.",
  };
}

export type RolePanelValidateResponse =
  | {
      ok: true;
      channelId: string;
      messageId: string;
      snapshot: {
        content: string;
        embedCount: number;
        foreignButtonRows: number;
        foreignReactionCount: number;
      };
      permissionWarnings: string[];
    }
  | { ok: false; error: string };

export async function validateRolePanelExistingMessage(
  _client: Client,
  guild: Guild,
  messageLink: string,
  triggerType: "reaction" | "button",
  selectionMode: "multiple" | "single",
): Promise<RolePanelValidateResponse> {
  const parsed = parseMessageLink(messageLink);
  if (!parsed || parsed.guildId !== guild.id) {
    return { ok: false, error: "That doesn't look like a message link from this server." };
  }

  const channel = await guild.channels.fetch(parsed.channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased() || !("send" in channel)) {
    return { ok: false, error: "Could not find that channel, or the bot can't see it." };
  }

  const message = await channel.messages.fetch(parsed.messageId).catch(() => null);
  if (!message) {
    return { ok: false, error: "Could not find that message — it may have been deleted, or the bot lacks Read Message History." };
  }

  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const warnings: string[] = [];
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) warnings.push("The bot can't view this channel.");
  if (triggerType === "reaction" && !perms?.has(PermissionFlagsBits.AddReactions)) {
    warnings.push("The bot needs Add Reactions in this channel.");
  }
  if (triggerType === "button" && !perms?.has(PermissionFlagsBits.SendMessages)) {
    warnings.push("The bot needs Send Messages (to edit this message's buttons) in this channel.");
  }
  if (triggerType === "reaction" && selectionMode === "single" && !perms?.has(PermissionFlagsBits.ManageMessages)) {
    warnings.push("Single-choice reaction panels need Manage Messages, to remove a member's other reaction when they pick a new role.");
  }

  const foreignButtonRows = (message.components ?? []).filter((row) => {
    const children = "components" in row ? row.components : [];
    return !children.some((c) => "customId" in c && typeof c.customId === "string" && c.customId.startsWith(ROLE_PANEL_PREFIX));
  }).length;
  const foreignReactionCount = [...message.reactions.cache.values()].filter((r) => !r.me).length;

  if (triggerType === "button") {
    // Rough remaining-room check against a fresh single-role build (real count is computed at sync time).
    const testRows = buildRolePanelButtonRows("preview", [{ role_id: "0", emoji: "", label: "x", style: "secondary" }], guild);
    if (foreignButtonRows + testRows.length > 5 && foreignButtonRows >= 5) {
      warnings.push("This message already has 5 other button rows — there's no room left for role buttons.");
    }
  }

  return {
    ok: true,
    channelId: channel.id,
    messageId: message.id,
    snapshot: {
      content: message.content ?? "",
      embedCount: message.embeds.length,
      foreignButtonRows,
      foreignReactionCount,
    },
    permissionWarnings: warnings,
  };
}
