import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import {
  baseEmbed,
  buildResultEmbed,
  embedField,
  setEmbedAuthor,
} from "../../../core/embeds.js";
import {
  AVATAR_REVIEW_CHANNEL_ID,
  botAvatarApproveCustomId,
  botAvatarDenyCustomId,
} from "../constants.js";
import {
  createBotAvatarRequest,
  updateBotAvatarRequestMessageIds,
  type BotAvatarRequest,
} from "./store.js";

const AVATAR_FILENAME = "avatar.png";

export function avatarAttachment(png: Buffer): AttachmentBuilder {
  return new AttachmentBuilder(png, { name: AVATAR_FILENAME });
}

export function avatarAttachmentUrl(): string {
  return `attachment://${AVATAR_FILENAME}`;
}

async function reviewChannel(client: Client): Promise<GuildTextBasedChannel | null> {
  const channel =
    client.channels.cache.get(AVATAR_REVIEW_CHANNEL_ID) ??
    (await client.channels.fetch(AVATAR_REVIEW_CHANNEL_ID).catch(() => null));
  if (!channel?.isTextBased() || channel.isDMBased()) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return null;
  }
  return channel;
}

export async function submitAvatarForReview(options: {
  client: Client;
  guildId: string;
  guildName: string;
  requesterId: string;
  requesterTag: string;
  requestChannelId: string;
  avatarPng: Buffer;
}): Promise<{ request: BotAvatarRequest; reviewPosted: boolean }> {
  const request = await createBotAvatarRequest({
    guildId: options.guildId,
    requesterId: options.requesterId,
    requestChannelId: options.requestChannelId,
    avatarPngBase64: options.avatarPng.toString("base64"),
  });

  const channel = await reviewChannel(options.client);
  if (!channel) {
    console.error(
      `[bot_customisation] Review channel ${AVATAR_REVIEW_CHANNEL_ID} missing or not a text channel`,
    );
    return { request, reviewPosted: false };
  }

  const file = avatarAttachment(options.avatarPng);
  const embed = setEmbedAuthor(baseEmbed(), "Avatar review", options.client, {
    tone: "warning",
  })
    .addFields(
      embedField(
        "Request",
        [
          `**Server:** ${options.guildName} (\`${options.guildId}\`)`,
          `**Requested by:** <@${options.requesterId}> (\`${options.requesterTag}\`)`,
          `**Request id:** \`${request.id}\``,
        ].join("\n"),
      ),
    )
    .setImage(avatarAttachmentUrl())
    .setFooter({ text: "Approve to apply this avatar in the requesting server only." });

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

export function pendingUserEmbed(
  client: Client,
  guildName: string,
  reviewPosted: boolean,
) {
  return buildResultEmbed(
    "Avatar pending review",
    reviewPosted
      ? `Dreamliner's new avatar for **${guildName}** is waiting for staff approval. You'll get a reply here when it's approved or denied.\n\nTo replace it, run \`/bot avatar cancel\` first, then set a new one.`
      : `Your request was saved, but Dreamliner could not reach the review channel. Staff have been notified via logs — try again later if nothing happens.`,
    {
      client,
      tone: "warning",
      imageURL: avatarAttachmentUrl(),
    },
  );
}

/** Disable the staff review message after a user cancels their queue entry. */
export async function markReviewMessageCancelled(
  client: Client,
  request: BotAvatarRequest,
  cancelledById: string,
): Promise<void> {
  if (!request.reviewMessageId) return;
  const channel = await reviewChannel(client);
  if (!channel) return;

  const message = await channel.messages.fetch(request.reviewMessageId).catch(() => null);
  if (!message) return;

  const guildName = client.guilds.cache.get(request.guildId)?.name ?? request.guildId;
  const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:botavatar:done:c:${request.id}`)
      .setLabel("Cancelled")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const embed = setEmbedAuthor(baseEmbed(), "Avatar cancelled", client, { tone: "unchecked" })
    .addFields(
      embedField(
        "Request",
        [
          `**Server:** ${guildName} (\`${request.guildId}\`)`,
          `**Requested by:** <@${request.requesterId}>`,
          `**Cancelled by:** <@${cancelledById}>`,
          `**Request id:** \`${request.id}\``,
          "**Status:** cancelled",
        ].join("\n"),
      ),
    )
    .setImage(avatarAttachmentUrl());

  await message
    .edit({
      embeds: [embed],
      components: [disabled],
      files: [avatarAttachment(Buffer.from(request.avatarPng, "base64"))],
    })
    .catch(() => null);
}
