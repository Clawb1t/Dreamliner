import {
  type ActionRow,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type MessageActionRowComponent,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { RolePanel } from "../../../config/schemas/rolePanels.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { emojiKeysMatch } from "../../../core/emoji.js";
import { parseMessageLink } from "../../../core/messageLink.js";
import { ROLE_PANEL_PREFIX } from "../customIds.js";
import {
  buildRolePanelButtonRows,
  buildRolePanelPayload,
  rolePanelHasContent,
  rolePanelMessageFingerprint,
  rolePanelPayloadFingerprint,
} from "./messageBuilder.js";
import {
  getRolePanelMessage,
  listRolePanelMessages,
  removeRolePanelMessage,
  upsertRolePanelMessage,
} from "./store.js";

const runChains = new Map<string, Promise<unknown>>();

function runExclusive(key: string, task: () => Promise<void>): Promise<void> {
  const previous = runChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  runChains.set(key, settled);
  void settled.then(() => {
    if (runChains.get(key) === settled) runChains.delete(key);
  });
  return current;
}

function loadPanels(guildConfig: GuildConfig): RolePanel[] {
  const section = guildConfig.plugins.role_panels as { config?: { panels?: RolePanel[] } } | undefined;
  return section?.config?.panels ?? [];
}

function asTextChannel(channel: unknown): GuildTextBasedChannel | null {
  if (
    !channel ||
    typeof channel !== "object" ||
    !("isTextBased" in channel) ||
    typeof (channel as { isTextBased?: unknown }).isTextBased !== "function"
  ) {
    return null;
  }
  const ch = channel as GuildTextBasedChannel;
  if (!ch.isTextBased() || ch.isDMBased() || !("send" in ch)) return null;
  return ch;
}

/** Sequential reaction add — never Promise.all, to stay gentle on the reaction-add rate limit. */
async function reactSequential(message: Message, emojis: string[]): Promise<void> {
  for (const emoji of emojis) {
    const trimmed = emoji.trim();
    if (!trimmed) continue;
    await message.react(trimmed).catch((error) => {
      console.warn(`[role_panels] Failed to add reaction ${trimmed} on ${message.id}:`, error instanceof Error ? error.message : error);
    });
  }
}

/** Removes any bot reaction not in `desiredEmojis`, adds any missing ones. Self-only, no extra permission needed. */
async function reconcileReactions(message: Message, desiredEmojis: string[]): Promise<void> {
  const botUserId = message.client.user?.id;
  if (!botUserId) return;

  for (const [, reaction] of message.reactions.cache) {
    if (!reaction.me) continue;
    const stillWanted = desiredEmojis.some((emoji) => emojiKeysMatch(emoji, reaction.emoji));
    if (!stillWanted) {
      await reaction.users.remove(botUserId).catch(() => null);
    }
  }

  const toAdd = desiredEmojis.filter((emoji) => {
    const existing = [...message.reactions.cache.values()].find((r) => r.me && emojiKeysMatch(emoji, r.emoji));
    return !existing;
  });
  await reactSequential(message, toAdd);
}

type ButtonReconcileResult = { ok: true } | { ok: false; error: string };

/** Strips our own button row(s) from a message's live components and rebuilds them from `roles`. */
async function reconcileButtons(
  message: Message,
  panelId: string,
  roles: RolePanel["roles"],
  guild: Guild,
): Promise<ButtonReconcileResult> {
  const ourPrefix = `${ROLE_PANEL_PREFIX}${panelId}:`;
  const currentRows = (message.components ?? []) as ActionRow<MessageActionRowComponent>[];
  const foreignRows = currentRows.filter((row) => {
    const children = "components" in row ? row.components : [];
    return !children.some((c) => "customId" in c && typeof c.customId === "string" && c.customId.startsWith(ourPrefix));
  });

  const newRows = roles.length ? buildRolePanelButtonRows(panelId, roles, guild) : [];
  if (foreignRows.length + newRows.length > 5) {
    return {
      ok: false,
      error: `This message already has ${foreignRows.length} other button row(s) — only ${5 - foreignRows.length} left for this panel, but it needs ${newRows.length}.`,
    };
  }

  const combined = [...foreignRows.map((row) => row.toJSON()), ...newRows];
  await message.edit({ components: combined }).catch((error) => {
    console.warn(`[role_panels] Failed to edit existing-message buttons on ${message.id}:`, error instanceof Error ? error.message : error);
  });
  return { ok: true };
}

async function syncBotModePanel(client: Client, guild: Guild, guildId: string, panel: RolePanel): Promise<void> {
  const tracked = await getRolePanelMessage(guildId, panel.id);
  const wantsContent = panel.enabled && rolePanelHasContent(panel);

  if (!wantsContent) {
    if (tracked) {
      const channel = await guild.channels.fetch(tracked.channelId).catch(() => null);
      const textChannel = asTextChannel(channel);
      if (textChannel) {
        await textChannel.messages.delete(tracked.messageId).catch(() => null);
      }
      await removeRolePanelMessage(guildId, panel.id);
    }
    return;
  }

  const channelRef = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const channel = asTextChannel(channelRef);
  if (!channel) {
    console.warn(`[role_panels] Panel ${panel.id} in guild ${guildId}: channel ${panel.channel_id} not found or not sendable.`);
    return;
  }

  const built = buildRolePanelPayload(panel, { client, guild, channel });
  const desiredFingerprint = rolePanelPayloadFingerprint(built, panel);

  const existing = tracked ? await channel.messages.fetch(tracked.messageId).catch(() => null) : null;

  if (existing) {
    if (rolePanelMessageFingerprint(existing) === (tracked?.fingerprint ?? "") && tracked?.fingerprint === desiredFingerprint) {
      return;
    }
    await existing.edit(built.payload).catch((error) => {
      console.warn(`[role_panels] Failed to edit panel ${panel.id} message:`, error instanceof Error ? error.message : error);
    });
    if (panel.trigger_type === "reaction") {
      await reconcileReactions(existing, panel.roles.map((r) => r.emoji));
    }
    await upsertRolePanelMessage({
      guildId,
      panelId: panel.id,
      channelId: channel.id,
      messageId: existing.id,
      postMode: "bot",
      fingerprint: desiredFingerprint,
      appliedRoleIds: panel.roles.map((r) => r.role_id),
    });
    return;
  }

  const sent = await channel.send(built.payload).catch(() => null);
  if (!sent) {
    console.warn(`[role_panels] Failed to send panel ${panel.id} message in ${channel.id}.`);
    return;
  }
  if (panel.trigger_type === "reaction") {
    await reactSequential(sent, panel.roles.map((r) => r.emoji));
  }
  await upsertRolePanelMessage({
    guildId,
    panelId: panel.id,
    channelId: channel.id,
    messageId: sent.id,
    postMode: "bot",
    fingerprint: desiredFingerprint,
    appliedRoleIds: panel.roles.map((r) => r.role_id),
  });
}

async function syncExistingModePanel(_client: Client, guild: Guild, guildId: string, panel: RolePanel): Promise<void> {
  const parsed = parseMessageLink(panel.existing_message_link);
  if (!parsed || parsed.guildId !== guildId) {
    console.warn(`[role_panels] Panel ${panel.id} in guild ${guildId}: invalid or mismatched existing_message_link.`);
    return;
  }

  const channelRef = await guild.channels.fetch(parsed.channelId).catch(() => null);
  const channel = asTextChannel(channelRef);
  if (!channel) return;

  const message = await channel.messages.fetch(parsed.messageId).catch(() => null);
  if (!message) return;

  const desiredRoles = panel.enabled ? panel.roles : [];

  if (panel.trigger_type === "reaction") {
    await reconcileReactions(message, desiredRoles.map((r) => r.emoji));
  } else {
    await reconcileButtons(message, panel.id, desiredRoles, guild);
  }

  if (!panel.enabled) {
    await removeRolePanelMessage(guildId, panel.id);
    return;
  }

  await upsertRolePanelMessage({
    guildId,
    panelId: panel.id,
    channelId: channel.id,
    messageId: message.id,
    postMode: "existing",
    appliedRoleIds: desiredRoles.map((r) => r.role_id),
  });
}

async function teardownRemovedPanel(client: Client, guildId: string, panelId: string, postMode: "bot" | "existing", channelId: string, messageId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    await removeRolePanelMessage(guildId, panelId);
    return;
  }
  const channelRef = await guild.channels.fetch(channelId).catch(() => null);
  const channel = asTextChannel(channelRef);
  if (channel) {
    if (postMode === "bot") {
      await channel.messages.delete(messageId).catch(() => null);
    } else {
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (message) {
        await reconcileReactions(message, []);
        await reconcileButtons(message, panelId, [], guild);
      }
    }
  }
  await removeRolePanelMessage(guildId, panelId);
}

export async function syncGuildRolePanels(
  client: Client,
  guildId: string,
  options?: { guildConfig?: GuildConfig },
): Promise<void> {
  const guildConfig = options?.guildConfig ?? (await configManager.getEffectiveConfig(guildId));
  const trackedRows = await listRolePanelMessages(guildId);

  if (!pluginEnabled(guildConfig, "role_panels")) return;

  const panels = loadPanels(guildConfig);
  const panelIds = new Set(panels.map((p) => p.id));

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  for (const row of trackedRows) {
    if (panelIds.has(row.panelId)) continue;
    await runExclusive(`${guildId}:${row.panelId}`, () =>
      teardownRemovedPanel(client, guildId, row.panelId, row.postMode, row.channelId, row.messageId),
    );
  }

  for (const panel of panels) {
    await runExclusive(`${guildId}:${panel.id}`, () =>
      panel.post_mode === "bot"
        ? syncBotModePanel(client, guild, guildId, panel)
        : syncExistingModePanel(client, guild, guildId, panel),
    );
  }
}

export async function handleRolePanelsReady(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await syncGuildRolePanels(client, guild.id).catch((error) => {
      console.error(`[role_panels] Failed to sync panels for ${guild.id}:`, error);
    });
  }
}
