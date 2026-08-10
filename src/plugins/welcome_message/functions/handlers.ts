import type { GuildMember, PartialGuildMember, TextChannel, User } from "discord.js";
import type { WelcomeMessageConfig } from "../../../config/schemas/welcome.js";
import { armFirstMessageReact, clearFirstMessageReact } from "./firstMessageReact.js";
import { loadWelcomeConfig } from "./loadConfig.js";
import {
  buildWelcomePayload,
  getWelcomeEventConfig,
  type WelcomeTarget,
} from "./messageBuilder.js";
import {
  deleteWelcomeJoinMessage,
  listRecentWelcomeJoinMessages,
  pruneOldWelcomeJoinMessages,
  trackWelcomeJoinMessage,
} from "./store.js";
import { EARLY_LEAVE_MS } from "./waveButton.js";

export { loadWelcomeConfig };

async function deliverWelcome(
  target: WelcomeTarget,
  options: {
    guildId: string;
    guild: GuildMember["guild"];
    member?: GuildMember | null;
    user?: User | null;
    config: WelcomeMessageConfig;
  },
): Promise<{ ok: boolean; detail: string; messageId?: string; channelId?: string }> {
  const event = getWelcomeEventConfig(options.config, target);
  if (!event.enabled) {
    return { ok: false, detail: `${target} messages are disabled.` };
  }

  const waveButton =
    target === "join" && options.config.wave_button?.enabled
      ? options.config.wave_button
      : null;

  const built = await buildWelcomePayload(
    event,
    {
      guildId: options.guildId,
      member: options.member ?? null,
      user: options.user ?? options.member?.user ?? null,
      guild: options.guild,
    },
    { waveButton },
  );

  if (built.empty) {
    return { ok: false, detail: `${target} message has no content, embed, card, or wave button.` };
  }

  if (target === "dm") {
    const user = options.user ?? options.member?.user;
    if (!user) return { ok: false, detail: "No user available for DM." };
    const dm = await user.createDM().catch(() => null);
    if (!dm) return { ok: false, detail: "Could not open a DM with that member." };
    await dm.send(built.payload).catch(() => null);
    return { ok: true, detail: "DM sent." };
  }

  const channelId = built.channelId;
  if (!channelId) {
    return { ok: false, detail: `No ${target} channel configured.` };
  }

  const channel = await options.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    return { ok: false, detail: `Configured ${target} channel is missing or not text-based.` };
  }

  const sent = await (channel as TextChannel).send(built.payload).catch(() => null);
  return {
    ok: Boolean(sent),
    detail: sent ? `Sent to <#${channelId}>.` : `Failed to send to <#${channelId}>.`,
    messageId: sent?.id,
    channelId,
  };
}

export async function sendWelcomeEvent(
  target: WelcomeTarget,
  member: GuildMember,
  config: WelcomeMessageConfig,
): Promise<{ ok: boolean; detail: string }> {
  const result = await deliverWelcome(target, {
    guildId: member.guild.id,
    guild: member.guild,
    member,
    user: member.user,
    config,
  });

  if (
    target === "join" &&
    result.ok &&
    result.messageId &&
    result.channelId &&
    (config.delete_join_on_early_leave || config.wave_button?.enabled)
  ) {
    await trackWelcomeJoinMessage({
      messageId: result.messageId,
      guildId: member.guild.id,
      channelId: result.channelId,
      memberId: member.id,
      waveEnabled: Boolean(config.wave_button?.enabled),
    });
  }

  return { ok: result.ok, detail: result.detail };
}

export async function handleWelcomeMemberAdd(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;

  const config = await loadWelcomeConfig(member.guild.id);
  if (!config) return;

  if (config.join.enabled && config.join.channel_id) {
    await sendWelcomeEvent("join", member, config);
  }

  if (config.dm.enabled) {
    await sendWelcomeEvent("dm", member, config);
  }

  if (config.first_message_react?.enabled && config.first_message_react.emoji?.trim()) {
    armFirstMessageReact(member.guild.id, member.id);
  }
}

async function deleteEarlyJoinWelcomes(
  guild: GuildMember["guild"],
  memberId: string,
): Promise<void> {
  const since = new Date(Date.now() - EARLY_LEAVE_MS);
  const rows = await listRecentWelcomeJoinMessages(guild.id, memberId, since);
  for (const row of rows) {
    const channel = await guild.channels.fetch(row.channelId).catch(() => null);
    if (channel?.isTextBased() && "messages" in channel) {
      await channel.messages.delete(row.messageId).catch(() => null);
    }
    await deleteWelcomeJoinMessage(row.messageId);
  }
}

export async function handleWelcomeMemberRemove(
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  if (!member.guild) return;
  const user = member.user ?? null;
  if (user?.bot) return;

  const config = await loadWelcomeConfig(member.guild.id);
  if (!config) return;

  clearFirstMessageReact(member.guild.id, member.id);

  if (config.delete_join_on_early_leave) {
    await deleteEarlyJoinWelcomes(member.guild, member.id);
  }

  // Drop tracking rows older than a day so the table stays small.
  await pruneOldWelcomeJoinMessages(new Date(Date.now() - EARLY_LEAVE_MS)).catch(() => null);

  if (!config.leave.enabled || !config.leave.channel_id) return;

  await deliverWelcome("leave", {
    guildId: member.guild.id,
    guild: member.guild,
    member: member.partial ? null : (member as GuildMember),
    user,
    config,
  });
}
