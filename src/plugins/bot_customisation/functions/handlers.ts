import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type ButtonInteraction,
  type GuildTextBasedChannel,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { buildResultEmbed, setEmbedAuthor, baseEmbed, embedField } from "../../../core/embeds.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parseBotAvatarCustomId } from "../constants.js";
import {
  getBotAvatarRequest,
  markBotAvatarRequestFailed,
  resolveBotAvatarRequest,
  type BotAvatarRequest,
} from "./store.js";
import { avatarAttachment, avatarAttachmentUrl } from "./review.js";

function asTextChannel(channel: unknown): GuildTextBasedChannel | null {
  if (
    channel &&
    typeof channel === "object" &&
    "isTextBased" in channel &&
    typeof (channel as { isTextBased: () => boolean }).isTextBased === "function" &&
    (channel as { isTextBased: () => boolean }).isTextBased() &&
    "isDMBased" in channel &&
    typeof (channel as { isDMBased: () => boolean }).isDMBased === "function" &&
    !(channel as { isDMBased: () => boolean }).isDMBased() &&
    "messages" in channel
  ) {
    return channel as GuildTextBasedChannel;
  }
  return null;
}

async function notifyRequester(
  interaction: ButtonInteraction,
  request: BotAvatarRequest,
  outcome: "approved" | "denied" | "failed",
  details: string,
): Promise<void> {
  const channel = asTextChannel(
    interaction.client.channels.cache.get(request.requestChannelId) ??
      (await interaction.client.channels.fetch(request.requestChannelId).catch(() => null)),
  );
  if (!channel) return;

  const embed = buildResultEmbed(
    outcome === "approved"
      ? "Avatar approved"
      : outcome === "denied"
        ? "Avatar denied"
        : "Avatar could not be applied",
    details,
    {
      client: interaction.client,
      tone: outcome === "approved" ? "success" : outcome === "denied" ? "unchecked" : "error",
      ...(outcome === "approved" ? { imageURL: avatarAttachmentUrl() } : {}),
    },
  );

  const files =
    outcome === "approved" ? [avatarAttachment(Buffer.from(request.avatarPng, "base64"))] : [];

  if (request.requestMessageId) {
    const original = await channel.messages.fetch(request.requestMessageId).catch(() => null);
    if (original) {
      await original
        .edit({
          content: null,
          embeds: [embed],
          files: outcome === "approved" ? files : [],
          components: [],
        })
        .catch(() => null);
      return;
    }
  }

  await channel
    .send({
      content: `<@${request.requesterId}>`,
      embeds: [embed],
      files,
      allowedMentions: { users: [request.requesterId] },
    })
    .catch(() => null);
}

async function finalizeReviewMessage(
  interaction: ButtonInteraction,
  request: BotAvatarRequest,
  outcome: "approved" | "denied" | "failed",
  reviewerId: string,
): Promise<void> {
  const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:botavatar:done:a:${request.id}`)
      .setLabel(outcome === "approved" ? "Approved" : outcome === "denied" ? "Denied" : "Failed")
      .setStyle(outcome === "approved" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const guildName =
    interaction.client.guilds.cache.get(request.guildId)?.name ?? request.guildId;

  const embed = setEmbedAuthor(
    baseEmbed(),
    outcome === "approved"
      ? "Avatar approved"
      : outcome === "denied"
        ? "Avatar denied"
        : "Avatar failed",
    interaction.client,
    {
      tone: outcome === "approved" ? "success" : outcome === "denied" ? "unchecked" : "error",
    },
  )
    .addFields(
      embedField(
        "Request",
        [
          `**Server:** ${guildName} (\`${request.guildId}\`)`,
          `**Requested by:** <@${request.requesterId}>`,
          `**Reviewed by:** <@${reviewerId}>`,
          `**Request id:** \`${request.id}\``,
          `**Status:** ${outcome}`,
        ].join("\n"),
      ),
    )
    .setImage(avatarAttachmentUrl());

  const payload = {
    embeds: [embed],
    components: [disabled],
    files: [avatarAttachment(Buffer.from(request.avatarPng, "base64"))],
  };

  if (interaction.message) {
    await interaction.message.edit(payload).catch(async () => {
      await interaction.editReply(payload).catch(() => null);
    });
  }
}

export async function handleBotAvatarButtonInteraction(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const parsed = parseBotAvatarCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "You need **Manage Server** in this server to review avatar requests.",
      ephemeral: true,
    });
    return true;
  }

  const request = await getBotAvatarRequest(parsed.requestId);
  if (!request) {
    await interaction.reply({ content: "That avatar request no longer exists.", ephemeral: true });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(request.guildId);
  if (!pluginEnabled(guildConfig, "bot_customisation")) {
    await interaction.reply({
      content: "The **bot_customisation** plugin is disabled for that server.",
      ephemeral: true,
    });
    return true;
  }

  if (request.status !== "pending") {
    await interaction.reply({
      content: `This request was already **${request.status}**.`,
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferUpdate();

  if (parsed.action === "deny") {
    const resolved = await resolveBotAvatarRequest(request.id, "denied", interaction.user.id);
    if (!resolved) {
      await interaction.followUp({ content: "Someone else already resolved this request.", ephemeral: true });
      return true;
    }

    await finalizeReviewMessage(interaction, resolved, "denied", interaction.user.id);
    await notifyRequester(
      interaction,
      resolved,
      "denied",
      `Staff denied the avatar change for **${interaction.client.guilds.cache.get(resolved.guildId)?.name ?? "your server"}**. Dreamliner's avatar was not changed.`,
    );
    return true;
  }

  // Claim the pending row first so Approve/Deny can't race.
  const claimed = await resolveBotAvatarRequest(request.id, "approved", interaction.user.id);
  if (!claimed) {
    await interaction.followUp({ content: "Someone else already resolved this request.", ephemeral: true });
    return true;
  }

  const png = Buffer.from(claimed.avatarPng, "base64");
  const targetGuild =
    interaction.client.guilds.cache.get(claimed.guildId) ??
    (await interaction.client.guilds.fetch(claimed.guildId).catch(() => null));

  if (!targetGuild) {
    await markBotAvatarRequestFailed(claimed.id);
    await finalizeReviewMessage(interaction, { ...claimed, status: "failed" }, "failed", interaction.user.id);
    await notifyRequester(
      interaction,
      claimed,
      "failed",
      "Staff approved the avatar, but Dreamliner is no longer in that server so it could not be applied.",
    );
    return true;
  }

  try {
    await targetGuild.members.editMe({
      avatar: png,
      reason: `Guild avatar approved by ${interaction.user.tag} (request #${claimed.id})`,
    });
  } catch (error) {
    await markBotAvatarRequestFailed(claimed.id);
    await finalizeReviewMessage(interaction, { ...claimed, status: "failed" }, "failed", interaction.user.id);
    const msg = error instanceof Error ? error.message : "Discord rejected the avatar.";
    await notifyRequester(
      interaction,
      claimed,
      "failed",
      `Staff approved the avatar, but Discord rejected applying it: ${msg}`,
    );
    return true;
  }

  await finalizeReviewMessage(interaction, claimed, "approved", interaction.user.id);
  await notifyRequester(
    interaction,
    claimed,
    "approved",
    `Staff approved the avatar for **${targetGuild.name}**. Dreamliner's look in that server is now updated.`,
  );
  return true;
}
