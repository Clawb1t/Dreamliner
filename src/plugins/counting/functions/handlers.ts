import type { GuildMember, GuildTextBasedChannel, Message, TextChannel } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zCountingConfig, type CountingChannel } from "../../../config/schemas/plugins.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { renderTemplate } from "../../../core/templates.js";
import { buildResultEmbed } from "../../../core/embeds.js";
import { containerReply } from "../../../core/responses.js";
import { safeEvaluateExpression } from "./math.js";
import { getCountingWebhook } from "./webhook.js";
import { getCountingState, recordSuccessfulCount, resetCountingState } from "./store.js";

type FailureReason = "invalid" | "out_of_turn" | "cooldown" | "wrong_number";
type MessageKind = "failure" | "milestone" | "record";

const KIND_EMOJI: Record<MessageKind, string> = {
  failure: "<:icons_Wrong:1544417460638457937>",
  milestone: "<:icons_tada:1544417975472492594>",
  record: "<:icons_trophy:1544418249721126922>",
};

function reasonText(reason: FailureReason, expected: number): string {
  switch (reason) {
    case "out_of_turn":
      return "You can't count twice in a row, someone else needs to go next!";
    case "cooldown":
      return "You're counting too fast, slow down a bit!";
    case "wrong_number":
      return `That wasn't the next number, it should've been **${expected}**.`;
    case "invalid":
      return "That's not a valid number.";
  }
}

function parseAttempt(content: string, channelConfig: CountingChannel): number | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (!channelConfig.allow_math) return null;
  const evaluated = safeEvaluateExpression(trimmed);
  return evaluated !== null && Number.isInteger(evaluated) ? evaluated : null;
}

function isRoleGated(member: GuildMember | null, channelConfig: CountingChannel): boolean {
  if (!member) return channelConfig.allowed_roles.length > 0;
  if (channelConfig.ignored_roles.some((roleId) => member.roles.cache.has(roleId))) return true;
  if (channelConfig.allowed_roles.length > 0) {
    return !channelConfig.allowed_roles.some((roleId) => member.roles.cache.has(roleId));
  }
  return false;
}

function restartCountFor(channelConfig: CountingChannel, brokenAtCount: number): number {
  if (channelConfig.reset_to === "last_milestone" && channelConfig.milestone_every > 0) {
    return Math.floor(brokenAtCount / channelConfig.milestone_every) * channelConfig.milestone_every;
  }
  return 0;
}

async function sendCountingMessage(
  kind: MessageKind,
  channel: GuildTextBasedChannel,
  channelConfig: CountingChannel,
  template: string,
  message: Message,
  extra: Record<string, string>,
): Promise<void> {
  if (!template.trim()) return;
  const text = renderTemplate(template, {
    member: message.member,
    guild: message.guild,
    channel: channel.isTextBased() ? (channel as TextChannel) : null,
    extra,
  }).trim();
  if (!text) return;

  const container = buildResultEmbed("", text, { emoji: KIND_EMOJI[kind], client: message.client });
  const payload = containerReply(container, false);

  if (channelConfig.use_webhook) {
    const hook = await getCountingWebhook(channel);
    if (hook) {
      const sent = await hook
        .send({
          ...payload,
          username: channelConfig.webhook_name.trim() || channelConfig.name.trim() || "Counting",
          avatarURL: channelConfig.webhook_avatar_url.trim() || undefined,
        })
        .catch(() => null);
      if (sent) return;
    }
  }

  await channel.send(payload).catch(() => null);
}

async function failCount(
  message: Message,
  channel: GuildTextBasedChannel,
  channelConfig: CountingChannel,
  input: { reason: FailureReason; attemptText: string; expected: number; currentCount: number; highestCount: number },
): Promise<void> {
  if (channelConfig.delete_wrong_messages) {
    await message.delete().catch(() => null);
  } else if (channelConfig.failure_reaction.trim()) {
    await message.react(channelConfig.failure_reaction).catch(() => null);
  }

  let restart = input.currentCount;
  if (channelConfig.reset_on_mistake) {
    restart = restartCountFor(channelConfig, input.currentCount);
    await resetCountingState({
      guildId: message.guild!.id,
      channelId: channel.id,
      resetCount: restart,
      highestCount: input.highestCount,
      now: new Date(),
    });
  }

  if (channelConfig.announce_failure) {
    await sendCountingMessage("failure", channel, channelConfig, channelConfig.failure_message, message, {
      reason: reasonText(input.reason, input.expected),
      number: input.attemptText,
      expected: String(input.expected),
      restart: String(restart),
      highest: String(input.highestCount),
    });
  }
}

export async function handleCountingMessage(message: Message): Promise<void> {
  if (!message.guild || !message.channel.isTextBased() || message.channel.isDMBased()) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "counting")) return;

  const pluginConfig = zCountingConfig.parse(getPluginSettings(guildConfig, "counting"));
  const channelConfig = pluginConfig.channels.find(
    (c) => c.enabled && c.channel_id === message.channel.id,
  );
  if (!channelConfig) return;

  if (message.author.bot && !channelConfig.allow_bots) return;

  const guildId = message.guild.id;
  const channel = message.channel as GuildTextBasedChannel;
  const state = await getCountingState(guildId, channel.id);
  const currentCount = state?.currentCount ?? channelConfig.start_at - channelConfig.step;
  const highestCount = state?.highestCount ?? 0;
  const expected = currentCount + channelConfig.step;

  const member =
    message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));

  if (isRoleGated(member, channelConfig)) {
    if (channelConfig.delete_wrong_messages) {
      await message.delete().catch(() => null);
    } else if (channelConfig.failure_reaction.trim()) {
      await message.react(channelConfig.failure_reaction).catch(() => null);
    }
    return;
  }

  const attempt = parseAttempt(message.content, channelConfig);

  if (attempt === null) {
    if (channelConfig.allow_non_number_messages) return;
    await failCount(message, channel, channelConfig, {
      reason: "invalid",
      attemptText: message.content.slice(0, 200) || "(empty)",
      expected,
      currentCount,
      highestCount,
    });
    return;
  }

  const outOfTurn = channelConfig.require_alternate_user && state?.lastUserId === message.author.id;
  const onCooldown =
    channelConfig.cooldown_seconds > 0 &&
    state?.lastCountAt != null &&
    (Date.now() - state.lastCountAt.getTime()) / 1000 < channelConfig.cooldown_seconds;

  if (outOfTurn || onCooldown || attempt !== expected) {
    await failCount(message, channel, channelConfig, {
      reason: outOfTurn ? "out_of_turn" : onCooldown ? "cooldown" : "wrong_number",
      attemptText: String(attempt),
      expected,
      currentCount,
      highestCount,
    });
    return;
  }

  const newHighest = Math.max(highestCount, expected);
  await recordSuccessfulCount({
    guildId,
    channelId: channel.id,
    count: expected,
    highestCount: newHighest,
    userId: message.author.id,
    messageId: message.id,
    now: new Date(),
  });

  if (channelConfig.success_reaction.trim()) {
    await message.react(channelConfig.success_reaction).catch(() => null);
  }

  const isMilestone = channelConfig.milestone_every > 0 && expected % channelConfig.milestone_every === 0;
  if (isMilestone) {
    if (channelConfig.milestone_reaction.trim()) {
      await message.react(channelConfig.milestone_reaction).catch(() => null);
    }
    if (channelConfig.announce_milestones) {
      await sendCountingMessage("milestone", channel, channelConfig, channelConfig.milestone_message, message, {
        number: String(expected),
        highest: String(newHighest),
      });
    }
    if (channelConfig.pin_milestones) {
      await message.pin().catch(() => null);
    }
  }

  const hadPreviousReset = (state?.totalResets ?? 0) > 0;
  if (channelConfig.announce_new_record && hadPreviousReset && expected > highestCount) {
    await sendCountingMessage("record", channel, channelConfig, channelConfig.record_message, message, {
      number: String(expected),
      highest: String(newHighest),
    });
  }
}
