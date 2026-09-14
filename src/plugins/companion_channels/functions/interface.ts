import {
  ActionRowBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type GuildMember,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resultReply } from "../../../core/responses.js";
import type { EmojisConfig } from "../../../config/schemas/guild.js";
import { translatorFor, type Translator } from "../../../i18n/index.js";
import {
  claimCompanion,
  ghostCompanion,
  lockCompanion,
  permitTarget,
  postLookingForMembers,
  rejectTarget,
  setCompanionBitrate,
  setCompanionLimit,
  setCompanionName,
  setCompanionRegion,
  setCompanionStatus,
  toggleCompanionNsfw,
  toggleCompanionText,
  transferCompanion,
  type CompanionActionResult,
  type CompanionActor,
} from "./actions.js";
import { loadCompanionConfig } from "./config.js";
import {
  COMPANION_ACCESS_ID,
  COMPANION_MODAL_PREFIX,
  COMPANION_PICK_PREFIX,
  COMPANION_REGION_ID,
  COMPANION_SETTINGS_ID,
} from "./panel.js";

function regionOptions(t: Translator) {
  return [
    { label: t("companion_channels.region.automatic", "Automatic"), value: "automatic" },
    { label: t("companion_channels.region.usEast", "US East"), value: "us-east" },
    { label: t("companion_channels.region.usWest", "US West"), value: "us-west" },
    { label: t("companion_channels.region.usCentral", "US Central"), value: "us-central" },
    { label: t("companion_channels.region.europe", "Europe"), value: "rotterdam" },
    { label: t("companion_channels.region.brazil", "Brazil"), value: "brazil" },
    { label: t("companion_channels.region.singapore", "Singapore"), value: "singapore" },
    { label: t("companion_channels.region.japan", "Japan"), value: "japan" },
    { label: t("companion_channels.region.sydney", "Sydney"), value: "sydney" },
    { label: t("companion_channels.region.india", "India"), value: "india" },
  ];
}

type InterfaceActor = CompanionActor & { emojis: EmojisConfig };

async function actorFrom(interaction: MessageComponentInteraction | ModalSubmitInteraction): Promise<InterfaceActor | null> {
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) return null;
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "companion_channels")) return null;
  return {
    member: interaction.member as GuildMember,
    config: loadCompanionConfig(guildConfig),
    emojis: guildConfig.emojis,
  };
}

function voiceFrom(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  const channel = interaction.channel;
  return channel && "isVoiceBased" in channel && channel.isVoiceBased() ? channel : null;
}

async function replyResult(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  result: CompanionActionResult,
  publicPing: boolean,
  emojis: EmojisConfig,
  t: Translator,
): Promise<void> {
  const payload = resultReply(t("companion_channels.title", "Companion"), result.message, !publicPing, {
    client: interaction.client,
    emojis,
    tone: result.ok ? "success" : "error",
    emoji: result.emoji,
  });
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
    return;
  }
  await interaction.reply(payload).catch(() => null);
}

function failResult(message: string): CompanionActionResult {
  return { ok: false, message };
}

function textModal(id: string, title: string, label: string, value = "", paragraph = false): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${COMPANION_MODAL_PREFIX}${id}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel(label)
          .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(paragraph ? 500 : 100)
          .setValue(value.slice(0, paragraph ? 500 : 100)),
      ),
    );
}

export async function handleCompanionSelectInteraction(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (
    interaction.customId !== COMPANION_SETTINGS_ID &&
    interaction.customId !== COMPANION_ACCESS_ID &&
    interaction.customId !== COMPANION_REGION_ID
  ) {
    return false;
  }

  const { t } = await translatorFor(interaction.user.id);
  const actor = await actorFrom(interaction);
  if (!actor) return true;
  const channel = voiceFrom(interaction);
  if (!channel) {
    await replyResult(
      interaction,
      failResult(t("companion_channels.error.useInVoiceChannel", "Use this in the temporary voice channel.")),
      false,
      actor.emojis,
      t,
    );
    return true;
  }

  const choice = interaction.values[0] ?? "";
  const ping = actor.config.features.interface_ping;

  if (interaction.customId === COMPANION_REGION_ID) {
    await replyResult(interaction, await setCompanionRegion(actor, channel, choice, t), ping, actor.emojis, t);
    return true;
  }

  if (choice === "name") {
    await interaction.showModal(
      textModal(
        "name",
        t("companion_channels.modal.rename.title", "Rename room"),
        t("companion_channels.modal.rename.label", "Channel name"),
        channel.name,
      ),
    );
    return true;
  }
  if (choice === "limit") {
    await interaction.showModal(
      textModal(
        "limit",
        t("companion_channels.modal.limit.title", "User limit"),
        t("companion_channels.modal.limit.label", "Limit (0 = unlimited)"),
        String(channel.userLimit ?? 0),
      ),
    );
    return true;
  }
  if (choice === "bitrate") {
    await interaction.showModal(
      textModal(
        "bitrate",
        t("companion_channels.modal.bitrate.title", "Bitrate"),
        t("companion_channels.modal.bitrate.label", "Bitrate in kbps (8–384)"),
        String(Math.round((channel.bitrate ?? 64000) / 1000)),
      ),
    );
    return true;
  }
  if (choice === "status") {
    await interaction.showModal(
      textModal(
        "status",
        t("companion_channels.modal.status.title", "Channel status"),
        t("companion_channels.modal.status.label", "Status"),
        "",
        true,
      ),
    );
    return true;
  }
  if (choice === "region") {
    await interaction.reply({
      ephemeral: true,
      content: t("companion_channels.prompt.chooseRegion", "Choose a voice region."),
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(COMPANION_REGION_ID)
            .setPlaceholder(t("companion_channels.select.voiceRegion", "Voice region"))
            .addOptions(regionOptions(t)),
        ),
      ],
    });
    return true;
  }
  if (choice === "permit" || choice === "reject") {
    await interaction.reply({
      ephemeral: true,
      content:
        choice === "permit"
          ? t("companion_channels.prompt.choosePermit", "Choose who to permit.")
          : t("companion_channels.prompt.chooseReject", "Choose who to reject."),
      components: [
        new ActionRowBuilder<MentionableSelectMenuBuilder>().addComponents(
          new MentionableSelectMenuBuilder()
            .setCustomId(`${COMPANION_PICK_PREFIX}${choice}`)
            .setPlaceholder(t("companion_channels.select.userOrRole", "User or role"))
            .setMinValues(1)
            .setMaxValues(1),
        ),
      ],
    });
    return true;
  }
  if (choice === "transfer") {
    await interaction.reply({
      ephemeral: true,
      content: t("companion_channels.prompt.chooseNewOwner", "Choose the new owner."),
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`${COMPANION_PICK_PREFIX}${choice}`)
            .setPlaceholder(t("companion_channels.select.member", "Select a member"))
            .setMinValues(1)
            .setMaxValues(1),
        ),
      ],
    });
    return true;
  }

  let result: CompanionActionResult = failResult(t("companion_channels.error.unknownAction", "Unknown action."));
  if (choice === "lock") result = await lockCompanion(actor, channel, true, t);
  else if (choice === "unlock") result = await lockCompanion(actor, channel, false, t);
  else if (choice === "ghost") result = await ghostCompanion(actor, channel, true, t);
  else if (choice === "unghost") result = await ghostCompanion(actor, channel, false, t);
  else if (choice === "nsfw") result = await toggleCompanionNsfw(actor, channel, t);
  else if (choice === "text") result = await toggleCompanionText(actor, channel, t);
  else if (choice === "lfm") result = await postLookingForMembers(actor, channel, t);
  else if (choice === "claim") result = await claimCompanion(actor, channel, t);

  await replyResult(interaction, result, ping, actor.emojis, t);
  return true;
}

export async function handleCompanionEntitySelect(interaction: MessageComponentInteraction): Promise<boolean> {
  if (!interaction.isMentionableSelectMenu() && !interaction.isUserSelectMenu()) return false;
  if (!interaction.customId.startsWith(COMPANION_PICK_PREFIX)) return false;

  const { t } = await translatorFor(interaction.user.id);
  const actor = await actorFrom(interaction);
  if (!actor) return true;
  const channel = voiceFrom(interaction);
  if (!channel) {
    await replyResult(
      interaction,
      failResult(t("companion_channels.error.useInVoiceChannel", "Use this in the temporary voice channel.")),
      false,
      actor.emojis,
      t,
    );
    return true;
  }

  const action = interaction.customId.slice(COMPANION_PICK_PREFIX.length);
  const ping = actor.config.features.interface_ping;
  let result: CompanionActionResult = failResult(t("companion_channels.error.nothingSelected", "Nothing selected."));

  if (interaction.isMentionableSelectMenu()) {
    const user = interaction.users.first();
    const rawRole = interaction.roles.first();
    const role = rawRole
      ? actor.member.guild.roles.cache.get(rawRole.id) ?? ("guild" in rawRole ? rawRole : null)
      : null;
    const target = user ?? role;
    if (!target) {
      await replyResult(interaction, failResult(t("companion_channels.error.pickUserOrRole", "Pick a user or role.")), false, actor.emojis, t);
      return true;
    }
    if (action === "permit") result = await permitTarget(actor, channel, target, t);
    if (action === "reject") result = await rejectTarget(actor, channel, target, t);
  } else {
    const user = interaction.users.first();
    if (!user) {
      await replyResult(interaction, failResult(t("companion_channels.error.pickMember", "Pick a member.")), false, actor.emojis, t);
      return true;
    }
    if (action === "transfer") result = await transferCompanion(actor, channel, user, t);
  }

  await replyResult(interaction, result, ping, actor.emojis, t);
  return true;
}

export async function handleCompanionModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(COMPANION_MODAL_PREFIX)) return false;
  const { t } = await translatorFor(interaction.user.id);
  const actor = await actorFrom(interaction);
  if (!actor) return true;
  const channel = voiceFrom(interaction);
  if (!channel) {
    await replyResult(
      interaction,
      failResult(t("companion_channels.error.useInVoiceChannel", "Use this in the temporary voice channel.")),
      false,
      actor.emojis,
      t,
    );
    return true;
  }

  const kind = interaction.customId.slice(COMPANION_MODAL_PREFIX.length);
  const value = interaction.fields.getTextInputValue("value");
  const ping = actor.config.features.interface_ping;
  let result: CompanionActionResult = failResult(t("companion_channels.error.unknownAction", "Unknown action."));
  if (kind === "name") result = await setCompanionName(actor, channel, value, t);
  else if (kind === "limit") result = await setCompanionLimit(actor, channel, Number(value) || 0, t);
  else if (kind === "bitrate") result = await setCompanionBitrate(actor, channel, Number(value) || 64, t);
  else if (kind === "status") result = await setCompanionStatus(actor, channel, value, t);
  await replyResult(interaction, result, ping, actor.emojis, t);
  return true;
}

export function isCompanionCustomId(customId: string): boolean {
  return (
    customId === COMPANION_SETTINGS_ID ||
    customId === COMPANION_ACCESS_ID ||
    customId === COMPANION_REGION_ID ||
    customId.startsWith(COMPANION_PICK_PREFIX) ||
    customId.startsWith(COMPANION_MODAL_PREFIX)
  );
}
