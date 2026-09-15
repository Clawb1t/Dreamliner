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
import { containerEdit, containerReply, pingComponent } from "../../../core/responses.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { translatorFor, type Translator } from "../../../i18n/index.js";
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

function kindLabel(kind: BotBrandImageKind, t: Translator): string {
  return kind === "banner" ? t("bot_customisation.kind.banner", "Banner") : t("bot_customisation.kind.avatar", "Avatar");
}

/** Avatar = profile photo (camera), banner = the wide art canvas (paint brush). */
function kindAppliedEmoji(kind: BotBrandImageKind): string {
  return kind === "banner" ? "<:icons_paintpadbrush:1544417365394071703>" : "<:icons_camera:1544417537180311684>";
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

  const { t } = await translatorFor(request.requesterId);
  const label = kindLabel(request.kind, t);
  const embed = buildResultEmbed(
    outcome === "approved"
      ? t("bot_customisation.notify.approved", "{label} approved", { label })
      : outcome === "denied"
        ? t("bot_customisation.notify.denied", "{label} denied", { label })
        : t("bot_customisation.notify.failed", "{label} could not be applied", { label }),
    details,
    {
      client: interaction.client,
      tone: outcome === "approved" ? "success" : outcome === "denied" ? "unchecked" : "error",
      ...(outcome === "approved"
        ? { imageURL: brandImageAttachmentUrl(request.kind), emoji: kindAppliedEmoji(request.kind) }
        : {}),
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
          ...containerEdit(embed),
          files: outcome === "approved" ? files : [],
        })
        .catch(() => null);
      return;
    }
  }

  const payload = containerReply(embed);
  await channel
    .send({
      ...payload,
      components: [pingComponent(`<@${request.requesterId}>`), ...payload.components!],
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
  const { t } = await translatorFor(reviewerId);
  const label = kindLabel(request.kind, t);
  const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:botavatar:done:a:${request.id}`)
      .setLabel(
        outcome === "approved"
          ? t("bot_customisation.button.approved", "Approved")
          : outcome === "denied"
            ? t("bot_customisation.button.denied", "Denied")
            : t("bot_customisation.button.failed", "Failed"),
      )
      .setStyle(outcome === "approved" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const guildName =
    interaction.client.guilds.cache.get(request.guildId)?.name ?? request.guildId;

  const embed = setEmbedAuthor(
    baseEmbed(),
    outcome === "approved"
      ? t("bot_customisation.notify.approved", "{label} approved", { label })
      : outcome === "denied"
        ? t("bot_customisation.notify.denied", "{label} denied", { label })
        : t("bot_customisation.review.failedTitle", "{label} failed", { label }),
    interaction.client,
    {
      tone: outcome === "approved" ? "success" : outcome === "denied" ? "unchecked" : "error",
      ...(outcome === "approved" ? { emoji: kindAppliedEmoji(request.kind) } : {}),
    },
  )
    .addFields(
      embedField(
        t("bot_customisation.review.requestField", "Request"),
        [
          t("bot_customisation.review.typeLine", "**Type:** {label}", { label }),
          t("bot_customisation.review.serverLine", "**Server:** {guildName} (`{guildId}`)", {
            guildName,
            guildId: request.guildId,
          }),
          t("bot_customisation.review.requestedByLine", "**Requested by:** <@{userId}>", {
            userId: request.requesterId,
          }),
          t("bot_customisation.review.reviewedByLine", "**Reviewed by:** <@{userId}>", { userId: reviewerId }),
          t("bot_customisation.review.requestIdLine", "**Request id:** `{id}`", { id: request.id }),
          t("bot_customisation.review.statusLine", "**Status:** {status}", { status: outcome }),
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(request.kind));

  const payload = {
    ...containerReply(embed, false, [disabled]),
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

  const { t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: t(
        "bot_customisation.error.needManageServer",
        "You need **Manage Server** in this server to review brand requests.",
      ),
      ephemeral: true,
    });
    return true;
  }

  const request = await getBotAvatarRequest(parsed.requestId);
  if (!request) {
    await interaction.reply({
      content: t("bot_customisation.error.requestGone", "That brand request no longer exists."),
      ephemeral: true,
    });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(request.guildId);
  if (!pluginEnabled(guildConfig, "bot_customisation")) {
    await interaction.reply({
      content: t(
        "bot_customisation.error.pluginDisabled",
        "The **bot_customisation** plugin is disabled for that server.",
      ),
      ephemeral: true,
    });
    return true;
  }

  if (parsed.action === "remove") {
    if (request.status !== "approved") {
      await interaction.reply({
        content: t(
          "bot_customisation.error.alreadyStatus",
          "This {kind} was already **{status}**.",
          { kind: kindLabel(request.kind, t).toLowerCase(), status: request.status },
        ),
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferUpdate();

    const removed = await markBotBrandRequestRemoved(request.id, interaction.user.id);
    if (!removed) {
      await interaction.followUp({
        content: t("bot_customisation.error.alreadyResolved", "Someone else already resolved this request."),
        ephemeral: true,
      });
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
      content: t("bot_customisation.error.requestAlreadyStatus", "This request was already **{status}**.", {
        status: request.status,
      }),
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferUpdate();

  const label = kindLabel(request.kind, t).toLowerCase();

  if (parsed.action === "deny") {
    const resolved = await resolveBotAvatarRequest(request.id, "denied", interaction.user.id);
    if (!resolved) {
      await interaction.followUp({
        content: t("bot_customisation.error.alreadyResolved", "Someone else already resolved this request."),
        ephemeral: true,
      });
      return true;
    }

    await finalizeReviewMessage(interaction, resolved, "denied", interaction.user.id);
    await notifyRequester(
      interaction,
      resolved,
      "denied",
      t(
        "bot_customisation.notify.deniedDetails",
        "Staff denied the {kind} change for **{guildName}**. Dreamliner's {kind} was not changed.",
        { kind: label, guildName: interaction.client.guilds.cache.get(resolved.guildId)?.name ?? t("bot_customisation.yourServer", "your server") },
      ),
    );
    return true;
  }

  // Claim the pending row first so Approve/Deny can't race.
  const claimed = await resolveBotAvatarRequest(request.id, "approved", interaction.user.id);
  if (!claimed) {
    await interaction.followUp({
      content: t("bot_customisation.error.alreadyResolved", "Someone else already resolved this request."),
      ephemeral: true,
    });
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
      t(
        "bot_customisation.notify.failedGuildGone",
        "Staff approved the {kind}, but Dreamliner is no longer in that server so it could not be applied.",
        { kind: label },
      ),
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
    const msg =
      error instanceof Error
        ? error.message
        : t("bot_customisation.notify.discordRejected", "Discord rejected the {kind}.", { kind: label });
    await notifyRequester(
      interaction,
      claimed,
      "failed",
      t(
        "bot_customisation.notify.failedDiscordRejected",
        "Staff approved the {kind}, but Discord rejected applying it: {message}",
        { kind: label, message: msg },
      ),
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
    t(
      "bot_customisation.notify.approvedDetails",
      "Staff approved the {kind} for **{guildName}**. Dreamliner's look in that server is now updated.",
      { kind: label, guildName: targetGuild.name },
    ),
  );
  return true;
}
