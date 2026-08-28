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
  DASHBOARD_REQUEST_CHANNEL,
  getBotAvatarRequest,
  markBotAvatarRequestFailed,
  markBotBrandRequestRemoved,
  resolveBotAvatarRequest,
  setStoredBrandImage,
  type BotAvatarRequest,
  type BotBrandImageKind,
} from "./store.js";
import { brandImageAttachment, brandImageAttachmentUrl, finalizeBrandLogRemoved } from "./review.js";

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

function kindLabel(kind: BotBrandImageKind): string {
  return kind === "banner" ? "Banner" : "Avatar";
}

async function notifyRequester(
  interaction: ButtonInteraction,
  request: BotAvatarRequest,
  outcome: "approved" | "denied" | "failed",
  details: string,
): Promise<void> {
  // Dashboard submissions have no Discord request message — the site polls status live.
  if (!request.requestChannelId || request.requestChannelId === DASHBOARD_REQUEST_CHANNEL) {
    return;
  }

  const channel = asTextChannel(
    interaction.client.channels.cache.get(request.requestChannelId) ??
      (await interaction.client.channels.fetch(request.requestChannelId).catch(() => null)),
  );
  if (!channel) return;

  const label = kindLabel(request.kind);
  const embed = buildResultEmbed(
    outcome === "approved"
      ? `${label} approved`
      : outcome === "denied"
        ? `${label} denied`
        : `${label} could not be applied`,
    details,
    {
      client: interaction.client,
      tone: outcome === "approved" ? "success" : outcome === "denied" ? "unchecked" : "error",
      ...(outcome === "approved" ? { imageURL: brandImageAttachmentUrl(request.kind) } : {}),
    },
  );

  const files =
    outcome === "approved"
      ? [brandImageAttachment(Buffer.from(request.avatarPng, "base64"), request.kind)]
      : [];

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
  const label = kindLabel(request.kind);
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
      ? `${label} approved`
      : outcome === "denied"
        ? `${label} denied`
        : `${label} failed`,
    interaction.client,
    {
      tone: outcome === "approved" ? "success" : outcome === "denied" ? "unchecked" : "error",
    },
  )
    .addFields(
      embedField(
        "Request",
        [
          `**Type:** ${label}`,
          `**Server:** ${guildName} (\`${request.guildId}\`)`,
          `**Requested by:** <@${request.requesterId}>`,
          `**Reviewed by:** <@${reviewerId}>`,
          `**Request id:** \`${request.id}\``,
          `**Status:** ${outcome}`,
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(request.kind));

  const payload = {
    embeds: [embed],
    components: [disabled],
    files: [brandImageAttachment(Buffer.from(request.avatarPng, "base64"), request.kind)],
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
      content: "You need **Manage Server** in this server to review brand requests.",
      ephemeral: true,
    });
    return true;
  }

  const request = await getBotAvatarRequest(parsed.requestId);
  if (!request) {
    await interaction.reply({ content: "That brand request no longer exists.", ephemeral: true });
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

  if (parsed.action === "remove") {
    if (request.status !== "approved") {
      await interaction.reply({
        content: `This ${kindLabel(request.kind).toLowerCase()} was already **${request.status}**.`,
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferUpdate();

    const removed = await markBotBrandRequestRemoved(request.id, interaction.user.id);
    if (!removed) {
      await interaction.followUp({ content: "Someone else already resolved this request.", ephemeral: true });
      return true;
    }

    const targetGuild =
      interaction.client.guilds.cache.get(removed.guildId) ??
      (await interaction.client.guilds.fetch(removed.guildId).catch(() => null));

    if (targetGuild) {
      try {
        await targetGuild.members.editMe({
          ...(removed.kind === "banner" ? { banner: null } : { avatar: null }),
          reason: `Guild ${removed.kind} removed by staff ${interaction.user.tag} (request #${removed.id})`,
        });
      } catch {
        // Keep the stored/log state as removed even if Discord rejects reverting the live asset.
      }
      await setStoredBrandImage(removed.guildId, removed.kind, "", interaction.user.id).catch(() => undefined);
    }

    await finalizeBrandLogRemoved(interaction.client, removed, interaction.user.id);
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

  const label = kindLabel(request.kind).toLowerCase();

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
      `Staff denied the ${label} change for **${interaction.client.guilds.cache.get(resolved.guildId)?.name ?? "your server"}**. Dreamliner's ${label} was not changed.`,
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
      `Staff approved the ${label}, but Dreamliner is no longer in that server so it could not be applied.`,
    );
    return true;
  }

  try {
    await targetGuild.members.editMe({
      ...(claimed.kind === "banner" ? { banner: png } : { avatar: png }),
      reason: `Guild ${claimed.kind} approved by ${interaction.user.tag} (request #${claimed.id})`,
    });
  } catch (error) {
    await markBotAvatarRequestFailed(claimed.id);
    await finalizeReviewMessage(interaction, { ...claimed, status: "failed" }, "failed", interaction.user.id);
    const msg = error instanceof Error ? error.message : `Discord rejected the ${label}.`;
    await notifyRequester(
      interaction,
      claimed,
      "failed",
      `Staff approved the ${label}, but Discord rejected applying it: ${msg}`,
    );
    return true;
  }

  await setStoredBrandImage(claimed.guildId, claimed.kind, claimed.avatarPng, interaction.user.id).catch(
    () => undefined,
  );

  await finalizeReviewMessage(interaction, claimed, "approved", interaction.user.id);
  await notifyRequester(
    interaction,
    claimed,
    "approved",
    `Staff approved the ${label} for **${targetGuild.name}**. Dreamliner's look in that server is now updated.`,
  );
  return true;
}
