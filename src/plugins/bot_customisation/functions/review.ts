import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import { baseEmbed, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import {
  BOT_BRAND_LOG_CHANNEL_ID,
  botAvatarApproveCustomId,
  botAvatarDenyCustomId,
  botBrandRemoveCustomId,
} from "../constants.js";
import {
  createBotBrandRequest,
  DASHBOARD_REQUEST_CHANNEL,
  updateBotAvatarRequestMessageIds,
  type BotAvatarRequest,
  type BotBrandImageKind,
} from "./store.js";

function imageFilename(kind: BotBrandImageKind): string {
  return kind === "banner" ? "banner.png" : "avatar.png";
}

export function brandImageAttachment(png: Buffer, kind: BotBrandImageKind = "avatar"): AttachmentBuilder {
  return new AttachmentBuilder(png, { name: imageFilename(kind) });
}

export function brandImageAttachmentUrl(kind: BotBrandImageKind = "avatar"): string {
  return `attachment://${imageFilename(kind)}`;
}

/** @deprecated Prefer brandImageAttachment */
export function avatarAttachment(png: Buffer): AttachmentBuilder {
  return brandImageAttachment(png, "avatar");
}

/** @deprecated Prefer brandImageAttachmentUrl */
export function avatarAttachmentUrl(): string {
  return brandImageAttachmentUrl("avatar");
}

async function brandLogChannel(client: Client): Promise<GuildTextBasedChannel | null> {
  const channel =
    client.channels.cache.get(BOT_BRAND_LOG_CHANNEL_ID) ??
    (await client.channels.fetch(BOT_BRAND_LOG_CHANNEL_ID).catch(() => null));
  if (!channel?.isTextBased() || channel.isDMBased()) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return null;
  }
  return channel;
}

function kindLabel(kind: BotBrandImageKind): string {
  return kind === "banner" ? "Banner" : "Avatar";
}

export async function submitBrandImageForReview(options: {
  client: Client;
  guildId: string;
  guildName: string;
  requesterId: string;
  requesterTag: string;
  requestChannelId?: string;
  imagePng: Buffer;
  kind: BotBrandImageKind;
}): Promise<{ request: BotAvatarRequest; reviewPosted: boolean }> {
  const request = await createBotBrandRequest({
    guildId: options.guildId,
    requesterId: options.requesterId,
    requestChannelId: options.requestChannelId ?? DASHBOARD_REQUEST_CHANNEL,
    imagePngBase64: options.imagePng.toString("base64"),
    kind: options.kind,
  });

  const channel = await brandLogChannel(options.client);
  if (!channel) {
    console.error(
      `[bot_customisation] Photo log channel ${BOT_BRAND_LOG_CHANNEL_ID} missing or not a text channel`,
    );
    return { request, reviewPosted: false };
  }

  const label = kindLabel(options.kind);
  const file = brandImageAttachment(options.imagePng, options.kind);
  const embed = setEmbedAuthor(baseEmbed(), `${label} review`, options.client, {
    tone: "warning",
  })
    .addFields(
      embedField(
        "Request",
        [
          `**Type:** ${label}`,
          `**Server:** ${options.guildName} (\`${options.guildId}\`)`,
          `**Requested by:** <@${options.requesterId}> (\`${options.requesterTag}\`)`,
          `**Source:** ${options.requestChannelId === DASHBOARD_REQUEST_CHANNEL || !options.requestChannelId ? "Dashboard" : "Discord"}`,
          `**Request id:** \`${request.id}\``,
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(options.kind))
    .setFooter({
      text: `Approve to apply this ${options.kind} in the requesting server only.`,
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(botAvatarApproveCustomId(request.id))
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(botAvatarDenyCustomId(request.id))
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  const reviewMessage = await channel.send({
    embeds: [embed],
    files: [file],
    components: [row],
  });

  await updateBotAvatarRequestMessageIds(request.id, { reviewMessageId: reviewMessage.id });
  return { request: { ...request, reviewMessageId: reviewMessage.id }, reviewPosted: true };
}

/** @deprecated Prefer submitBrandImageForReview */
export async function submitAvatarForReview(options: {
  client: Client;
  guildId: string;
  guildName: string;
  requesterId: string;
  requesterTag: string;
  requestChannelId: string;
  avatarPng: Buffer;
}): Promise<{ request: BotAvatarRequest; reviewPosted: boolean }> {
  return submitBrandImageForReview({
    client: options.client,
    guildId: options.guildId,
    guildName: options.guildName,
    requesterId: options.requesterId,
    requesterTag: options.requesterTag,
    requestChannelId: options.requestChannelId,
    imagePng: options.avatarPng,
    kind: "avatar",
  });
}

/**
 * Applies immediately — no staff gate. Posts a photo-log message with a single
 * "Remove" button so staff can moderate after the fact instead of approving beforehand.
 */
export async function logBrandImageApplied(options: {
  client: Client;
  guildName: string;
  requesterId: string;
  requesterTag: string;
  request: BotAvatarRequest;
  imagePng: Buffer;
  kind: BotBrandImageKind;
}): Promise<{ logPosted: boolean }> {
  const channel = await brandLogChannel(options.client);
  if (!channel) {
    console.error(
      `[bot_customisation] Photo log channel ${BOT_BRAND_LOG_CHANNEL_ID} missing or not a text channel`,
    );
    return { logPosted: false };
  }

  const label = kindLabel(options.kind);
  const file = brandImageAttachment(options.imagePng, options.kind);
  const embed = setEmbedAuthor(baseEmbed(), `${label} updated`, options.client, {
    tone: "success",
  })
    .addFields(
      embedField(
        "Change",
        [
          `**Type:** ${label}`,
          `**Server:** ${options.guildName} (\`${options.request.guildId}\`)`,
          `**Set by:** <@${options.requesterId}> (\`${options.requesterTag}\`)`,
          `**Source:** ${options.request.requestChannelId === DASHBOARD_REQUEST_CHANNEL ? "Dashboard" : "Discord"}`,
          `**Request id:** \`${options.request.id}\``,
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(options.kind))
    .setFooter({
      text: `Live now in the server. Remove pulls it back to Dreamliner's default ${options.kind}.`,
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(botBrandRemoveCustomId(options.request.id))
      .setLabel("Remove")
      .setStyle(ButtonStyle.Danger),
  );

  const logMessage = await channel.send({
    embeds: [embed],
    files: [file],
    components: [row],
  });

  await updateBotAvatarRequestMessageIds(options.request.id, { reviewMessageId: logMessage.id });
  return { logPosted: true };
}

/** Disable the photo-log message once staff removes a live avatar/banner. */
export async function finalizeBrandLogRemoved(
  client: Client,
  request: BotAvatarRequest,
  removedById: string,
): Promise<void> {
  if (!request.reviewMessageId) return;
  const channel = await brandLogChannel(client);
  if (!channel) return;

  const message = await channel.messages.fetch(request.reviewMessageId).catch(() => null);
  if (!message) return;

  const guildName = client.guilds.cache.get(request.guildId)?.name ?? request.guildId;
  const label = kindLabel(request.kind);
  const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:botavatar:done:r:${request.id}`)
      .setLabel("Removed")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const embed = setEmbedAuthor(baseEmbed(), `${label} removed`, client, { tone: "unchecked" })
    .addFields(
      embedField(
        "Change",
        [
          `**Type:** ${label}`,
          `**Server:** ${guildName} (\`${request.guildId}\`)`,
          `**Set by:** <@${request.requesterId}>`,
          `**Removed by:** <@${removedById}>`,
          `**Request id:** \`${request.id}\``,
          "**Status:** removed",
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(request.kind));

  await message
    .edit({
      embeds: [embed],
      components: [disabled],
      files: [brandImageAttachment(Buffer.from(request.avatarPng, "base64"), request.kind)],
    })
    .catch(() => null);
}

/** Disable the staff review message after a user cancels their queue entry. */
export async function markReviewMessageCancelled(
  client: Client,
  request: BotAvatarRequest,
  cancelledById: string,
): Promise<void> {
  if (!request.reviewMessageId) return;
  const channel = await brandLogChannel(client);
  if (!channel) return;

  const message = await channel.messages.fetch(request.reviewMessageId).catch(() => null);
  if (!message) return;

  const guildName = client.guilds.cache.get(request.guildId)?.name ?? request.guildId;
  const label = kindLabel(request.kind);
  const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:botavatar:done:c:${request.id}`)
      .setLabel("Cancelled")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const embed = setEmbedAuthor(baseEmbed(), `${label} cancelled`, client, { tone: "unchecked" })
    .addFields(
      embedField(
        "Request",
        [
          `**Type:** ${label}`,
          `**Server:** ${guildName} (\`${request.guildId}\`)`,
          `**Requested by:** <@${request.requesterId}>`,
          `**Cancelled by:** <@${cancelledById}>`,
          `**Request id:** \`${request.id}\``,
          "**Status:** cancelled",
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(request.kind));

  await message
    .edit({
      embeds: [embed],
      components: [disabled],
      files: [brandImageAttachment(Buffer.from(request.avatarPng, "base64"), request.kind)],
    })
    .catch(() => null);
}
