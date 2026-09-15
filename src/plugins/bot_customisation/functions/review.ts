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
import { containerReply } from "../../../core/responses.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
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
import { getLogger } from "../../../core/logger.js";
const log = getLogger("bot_customisation");

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

function kindLabel(kind: BotBrandImageKind, t: Translator = defaultTranslator): string {
  return kind === "banner" ? t("bot_customisation.kind.banner", "Banner") : t("bot_customisation.kind.avatar", "Avatar");
}

/** Avatar = profile photo (camera), banner = the wide art canvas (paint brush). */
function kindAppliedEmoji(kind: BotBrandImageKind): string {
  return kind === "banner" ? "<:icons_paintpadbrush:1544417365394071703>" : "<:icons_camera:1544417537180311684>";
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
    log.error(
      `[bot_customisation] Photo log channel ${BOT_BRAND_LOG_CHANNEL_ID} missing or not a text channel`,
    );
    return { request, reviewPosted: false };
  }

  const t = defaultTranslator;
  const label = kindLabel(options.kind, t);
  const file = brandImageAttachment(options.imagePng, options.kind);
  const embed = setEmbedAuthor(baseEmbed(), t("bot_customisation.review.reviewTitle", "{label} review", { label }), options.client, {
    tone: "warning",
    emoji: "<:icons_hoursglass:1544417711864549479>",
  })
    .addFields(
      embedField(
        t("bot_customisation.review.requestField", "Request"),
        [
          t("bot_customisation.review.typeLine", "**Type:** {label}", { label }),
          t("bot_customisation.review.serverLine", "**Server:** {guildName} (`{guildId}`)", {
            guildName: options.guildName,
            guildId: options.guildId,
          }),
          t("bot_customisation.review.requestedByTagLine", "**Requested by:** <@{userId}> (`{tag}`)", {
            userId: options.requesterId,
            tag: options.requesterTag,
          }),
          t("bot_customisation.review.sourceLine", "**Source:** {source}", {
            source:
              options.requestChannelId === DASHBOARD_REQUEST_CHANNEL || !options.requestChannelId
                ? t("bot_customisation.source.dashboard", "Dashboard")
                : t("bot_customisation.source.discord", "Discord"),
          }),
          t("bot_customisation.review.requestIdLine", "**Request id:** `{id}`", { id: request.id }),
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(options.kind))
    .setFooter({
      text: t(
        "bot_customisation.review.approveFooter",
        "Approve to apply this {kind} in the requesting server only.",
        { kind: options.kind },
      ),
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(botAvatarApproveCustomId(request.id))
      .setLabel(t("bot_customisation.button.approve", "Approve"))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(botAvatarDenyCustomId(request.id))
      .setLabel(t("bot_customisation.button.deny", "Deny"))
      .setStyle(ButtonStyle.Danger),
  );

  const reviewMessage = await channel.send({
    ...containerReply(embed, false, [row]),
    files: [file],
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
    log.error(
      `[bot_customisation] Photo log channel ${BOT_BRAND_LOG_CHANNEL_ID} missing or not a text channel`,
    );
    return { logPosted: false };
  }

  const t = defaultTranslator;
  const label = kindLabel(options.kind, t);
  const file = brandImageAttachment(options.imagePng, options.kind);
  const embed = setEmbedAuthor(baseEmbed(), t("bot_customisation.review.updatedTitle", "{label} updated", { label }), options.client, {
    tone: "success",
    emoji: kindAppliedEmoji(options.kind),
  })
    .addFields(
      embedField(
        t("bot_customisation.review.changeField", "Change"),
        [
          t("bot_customisation.review.typeLine", "**Type:** {label}", { label }),
          t("bot_customisation.review.serverLine", "**Server:** {guildName} (`{guildId}`)", {
            guildName: options.guildName,
            guildId: options.request.guildId,
          }),
          t("bot_customisation.review.setByTagLine", "**Set by:** <@{userId}> (`{tag}`)", {
            userId: options.requesterId,
            tag: options.requesterTag,
          }),
          t("bot_customisation.review.sourceLine", "**Source:** {source}", {
            source:
              options.request.requestChannelId === DASHBOARD_REQUEST_CHANNEL
                ? t("bot_customisation.source.dashboard", "Dashboard")
                : t("bot_customisation.source.discord", "Discord"),
          }),
          t("bot_customisation.review.requestIdLine", "**Request id:** `{id}`", { id: options.request.id }),
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(options.kind))
    .setFooter({
      text: t(
        "bot_customisation.review.liveFooter",
        "Live now in the server. Remove pulls it back to Dreamliner's default {kind}.",
        { kind: options.kind },
      ),
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(botBrandRemoveCustomId(options.request.id))
      .setLabel(t("bot_customisation.button.remove", "Remove"))
      .setStyle(ButtonStyle.Danger),
  );

  const logMessage = await channel.send({
    ...containerReply(embed, false, [row]),
    files: [file],
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

  const t = defaultTranslator;
  const guildName = client.guilds.cache.get(request.guildId)?.name ?? request.guildId;
  const label = kindLabel(request.kind, t);
  const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:botavatar:done:r:${request.id}`)
      .setLabel(t("bot_customisation.button.removed", "Removed"))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const embed = setEmbedAuthor(baseEmbed(), t("bot_customisation.review.removedTitle", "{label} removed", { label }), client, { tone: "unchecked" })
    .addFields(
      embedField(
        t("bot_customisation.review.changeField", "Change"),
        [
          t("bot_customisation.review.typeLine", "**Type:** {label}", { label }),
          t("bot_customisation.review.serverLine", "**Server:** {guildName} (`{guildId}`)", {
            guildName,
            guildId: request.guildId,
          }),
          t("bot_customisation.review.setByLine", "**Set by:** <@{userId}>", { userId: request.requesterId }),
          t("bot_customisation.review.removedByLine", "**Removed by:** <@{userId}>", { userId: removedById }),
          t("bot_customisation.review.requestIdLine", "**Request id:** `{id}`", { id: request.id }),
          t("bot_customisation.review.statusRemoved", "**Status:** removed"),
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(request.kind));

  await message
    .edit({
      ...containerReply(embed, false, [disabled]),
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

  const t = defaultTranslator;
  const guildName = client.guilds.cache.get(request.guildId)?.name ?? request.guildId;
  const label = kindLabel(request.kind, t);
  const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:botavatar:done:c:${request.id}`)
      .setLabel(t("bot_customisation.button.cancelled", "Cancelled"))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  const embed = setEmbedAuthor(baseEmbed(), t("bot_customisation.review.cancelledTitle", "{label} cancelled", { label }), client, { tone: "unchecked" })
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
          t("bot_customisation.review.cancelledByLine", "**Cancelled by:** <@{userId}>", { userId: cancelledById }),
          t("bot_customisation.review.requestIdLine", "**Request id:** `{id}`", { id: request.id }),
          t("bot_customisation.review.statusCancelled", "**Status:** cancelled"),
        ].join("\n"),
      ),
    )
    .setImage(brandImageAttachmentUrl(request.kind));

  await message
    .edit({
      ...containerReply(embed, false, [disabled]),
      files: [brandImageAttachment(Buffer.from(request.avatarPng, "base64"), request.kind)],
    })
    .catch(() => null);
}
