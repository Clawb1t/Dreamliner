import type { Guild, GuildMember, GuildTextBasedChannel, MessageCreateOptions } from "discord.js";
import type { PassportConfig } from "../../../config/schemas/passport.js";
import {
  buildPassportDmPayload,
  buildPassportPanelPayload,
  buildPassportPingPayload,
} from "./messageBuilder.js";

function asSendChannel(channel: unknown): GuildTextBasedChannel | null {
  if (!channel || typeof channel !== "object") return null;
  const ch = channel as { isTextBased?: () => boolean; isDMBased?: () => boolean; send?: unknown };
  if (!ch.isTextBased?.() || ch.isDMBased?.() || typeof ch.send !== "function") return null;
  return channel as GuildTextBasedChannel;
}

export async function resolvePassportChannel(
  guild: Guild,
  channelId: string | undefined,
): Promise<GuildTextBasedChannel | null> {
  const id = channelId?.trim();
  if (!id) return null;
  const cached = guild.channels.cache.get(id);
  const channel = cached ?? (await guild.channels.fetch(id).catch(() => null));
  return asSendChannel(channel);
}

async function sendPayload(
  channel: GuildTextBasedChannel,
  payload: MessageCreateOptions,
): Promise<{ messageId: string; channelId: string } | null> {
  const sent = await channel.send(payload).catch(() => null);
  if (!sent) return null;
  return { messageId: sent.id, channelId: sent.channelId };
}

export async function deletePassportMessage(
  guild: Guild,
  channelId: string | null | undefined,
  messageId: string | null | undefined,
): Promise<void> {
  if (!channelId || !messageId) return;
  const channel = await resolvePassportChannel(guild, channelId);
  if (!channel) return;
  await channel.messages.delete(messageId).catch(() => null);
}

export async function postPassportPing(
  member: GuildMember,
  config: PassportConfig,
): Promise<{ messageId: string; channelId: string } | null> {
  if (!config.ping.enabled) return null;
  const channel = await resolvePassportChannel(member.guild, config.channel_id);
  if (!channel) return null;
  const payload = buildPassportPingPayload(config.ping, {
    member,
    user: member.user,
    guild: member.guild,
  });
  if (!payload.content && !(payload.embeds && payload.embeds.length)) {
    payload.content = `Hey <@${member.id}>, welcome to **${member.guild.name}**.\n\nTap **Verify** to unlock the rest of the server.`;
  }
  return sendPayload(channel, payload);
}

export async function dmPassportLink(member: GuildMember, config: PassportConfig): Promise<void> {
  if (!config.ping.also_dm) return;
  const payload = buildPassportDmPayload(config, {
    member,
    user: member.user,
    guild: member.guild,
  });
  await member.send(payload).catch(() => null);
}

export async function postPassportPanel(
  guild: Guild,
  config: PassportConfig,
  actor?: GuildMember | null,
): Promise<{ ok: boolean; detail: string; messageId?: string; channelId?: string }> {
  const channel = await resolvePassportChannel(guild, config.channel_id);
  if (!channel) {
    return { ok: false, detail: "Set a verify channel first." };
  }
  const payload = buildPassportPanelPayload(config.panel, {
    member: actor ?? null,
    user: actor?.user ?? null,
    guild,
  });
  if (!payload.content && !(payload.embeds && payload.embeds.length)) {
    payload.content = `Verify with **Passport** to unlock **${guild.name}**.`;
  }
  const sent = await sendPayload(channel, payload);
  if (!sent) return { ok: false, detail: "Could not post the panel. Check my channel permissions." };
  return {
    ok: true,
    detail: `Posted the Passport panel in <#${sent.channelId}>.`,
    messageId: sent.messageId,
    channelId: sent.channelId,
  };
}

export async function sendPassportTestPing(
  member: GuildMember,
  config: PassportConfig,
): Promise<{ ok: boolean; detail: string }> {
  const posted = await postPassportPing(member, { ...config, ping: { ...config.ping, enabled: true } });
  if (!posted) {
    return { ok: false, detail: "Could not send a test ping. Set a verify channel and check my permissions." };
  }
  return { ok: true, detail: `Sent a test ping in <#${posted.channelId}>.` };
}
