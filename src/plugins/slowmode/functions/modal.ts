import * as Discord from "discord.js";
import {
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { zSlowmodeConfig, type SlowmodeRuleTarget } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { hasPluginPermission, resolvePluginConfig } from "../../../core/permissions.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import {
  ALL_CHANNELS,
  formatSlowmodeRule,
  nextSlowmodeRuleId,
  normalizeSlowmodeRules,
  type NormalizedSlowmodeRule,
} from "./rules.js";
import { invalidateSlowmodeConfigCache } from "./handlers.js";

type AnyLabelBuilder = {
  setLabel(label: string): AnyLabelBuilder;
  setDescription(description: string): AnyLabelBuilder;
  setUserSelectMenuComponent(input: unknown): AnyLabelBuilder;
  setRoleSelectMenuComponent(input: unknown): AnyLabelBuilder;
  setChannelSelectMenuComponent(input: unknown): AnyLabelBuilder;
  setTextInputComponent(input: unknown): AnyLabelBuilder;
  setRadioGroupComponent(input: unknown): AnyLabelBuilder;
};

type AnyRadioGroupOptionBuilder = {
  setValue(value: string): AnyRadioGroupOptionBuilder;
  setLabel(label: string): AnyRadioGroupOptionBuilder;
  setDescription(description: string): AnyRadioGroupOptionBuilder;
  setDefault(isDefault?: boolean): AnyRadioGroupOptionBuilder;
};

type AnyRadioGroupBuilder = {
  setCustomId(customId: string): AnyRadioGroupBuilder;
  setRequired(required?: boolean): AnyRadioGroupBuilder;
  addOptions(...options: AnyRadioGroupOptionBuilder[]): AnyRadioGroupBuilder;
};

const DiscordBuilders = Discord as unknown as {
  LabelBuilder: new () => AnyLabelBuilder;
  RadioGroupBuilder: new () => AnyRadioGroupBuilder;
  RadioGroupOptionBuilder: new () => AnyRadioGroupOptionBuilder;
};

const LabelBuilder = DiscordBuilders.LabelBuilder;
const RadioGroupBuilder = DiscordBuilders.RadioGroupBuilder;
const RadioGroupOptionBuilder = DiscordBuilders.RadioGroupOptionBuilder;

export const SLOWMODE_RULE_ADD_MODAL_ID = "dl:sm:rule_add";

const FIELD = {
  targetType: "dl:sm:target_type",
  user: "dl:sm:user",
  role: "dl:sm:role",
  seconds: "dl:sm:seconds",
  channel: "dl:sm:channel",
} as const;

export function buildSlowmodeRuleAddModal(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(SLOWMODE_RULE_ADD_MODAL_ID).setTitle("Add individual slowmode");

  (modal as ModalBuilder & { addLabelComponents: (...args: unknown[]) => ModalBuilder }).addLabelComponents(
    new LabelBuilder()
      .setLabel("Apply to")
      .setDescription("User rules override role rules. Among roles, the lowest delay wins.")
      .setRadioGroupComponent(
        new RadioGroupBuilder()
          .setCustomId(FIELD.targetType)
          .setRequired(true)
          .addOptions(
            new RadioGroupOptionBuilder()
              .setValue("role")
              .setLabel("Role")
              .setDescription("Everyone with this role")
              .setDefault(true),
            new RadioGroupOptionBuilder()
              .setValue("user")
              .setLabel("User")
              .setDescription("One specific member"),
          ),
      ),
    new LabelBuilder()
      .setLabel("User")
      .setDescription("Required when Apply to is User. Ignored for role rules.")
      .setUserSelectMenuComponent(
        new UserSelectMenuBuilder().setCustomId(FIELD.user).setPlaceholder("Select a user…").setRequired(false).setMinValues(0).setMaxValues(1),
      ),
    new LabelBuilder()
      .setLabel("Role")
      .setDescription("Required when Apply to is Role. Ignored for user rules.")
      .setRoleSelectMenuComponent(
        new RoleSelectMenuBuilder().setCustomId(FIELD.role).setPlaceholder("Select a role…").setRequired(false).setMinValues(0).setMaxValues(1),
      ),
    new LabelBuilder()
      .setLabel("Delay (seconds)")
      .setDescription("How long they must wait between messages (1–21600).")
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(FIELD.seconds)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(5)
          .setPlaceholder("e.g. 6"),
      ),
    new LabelBuilder()
      .setLabel("Channel")
      .setDescription("Optional. Leave empty to apply in every channel.")
      .setChannelSelectMenuComponent(
        new ChannelSelectMenuBuilder()
          .setCustomId(FIELD.channel)
          .setPlaceholder("All channels")
          .setRequired(false)
          .setMinValues(0)
          .setMaxValues(1)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  );

  return modal;
}

export async function createSlowmodeRule(
  configManager: ConfigManager,
  guildId: string,
  userId: string,
  pluginConfig: Record<string, unknown>,
  input: {
    target: SlowmodeRuleTarget;
    targetId: string;
    seconds: number;
    channelId?: string;
  },
): Promise<
  { ok: true; rule: NormalizedSlowmodeRule } | { ok: false; title: string; message: string; tone?: "error" | "warning" }
> {
  if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 21600) {
    return {
      ok: false,
      title: "Invalid delay",
      message: "Delay must be a whole number of seconds between **1** and **21600**.",
      tone: "error",
    };
  }

  const config = zSlowmodeConfig.parse(pluginConfig);
  const rules = normalizeSlowmodeRules(config.rules);
  const channels = input.channelId ? [input.channelId] : [ALL_CHANNELS];

  const duplicate = rules.some(
    (rule) =>
      rule.target === input.target &&
      rule.target_id === input.targetId &&
      rule.seconds === input.seconds &&
      rule.channels.length === channels.length &&
      rule.channels.every((id) => channels.includes(id)),
  );
  if (duplicate) {
    return { ok: false, title: "Already exists", message: "That slowmode rule already exists.", tone: "warning" };
  }

  const newRule: NormalizedSlowmodeRule = {
    id: nextSlowmodeRuleId(rules),
    target: input.target,
    target_id: input.targetId,
    seconds: input.seconds,
    channels,
  };

  const result = await configManager.patchPluginConfig(guildId, "slowmode", { rules: [...rules, newRule] }, userId);
  if (!result.success) {
    return { ok: false, title: "Error", message: result.errors.join("\n"), tone: "error" };
  }

  invalidateSlowmodeConfigCache(guildId);

  return { ok: true, rule: newRule };
}

export async function handleSlowmodeRuleModalSubmit(
  interaction: ModalSubmitInteraction,
  configManager: ConfigManager,
): Promise<boolean> {
  if (interaction.customId !== SLOWMODE_RULE_ADD_MODAL_ID) return false;
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const member = interaction.member;
  if (!member || typeof member === "string") {
    await interaction.reply(resultReply("Member error", "Could not resolve member.", true));
    return true;
  }

  const guildMember = member as import("discord.js").GuildMember;
  const channelId = interaction.channelId ?? "";
  const categoryId =
    interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
  const defaults = getPluginDefaultOverrides("slowmode");
  const ephemeral = resolveEphemeral(guildConfig);
  const opts = guildResultOptions(interaction.client, guildConfig);

  if (!hasPluginPermission(guildConfig, "slowmode", "can_manage_rules", guildMember, channelId, categoryId, defaults)) {
    await interaction.reply(
      resultReply("Permission denied", "You do not have permission to manage slowmode rules.", ephemeral, {
        ...opts,
        tone: "error",
      }),
    );
    return true;
  }

  const targetType = interaction.fields.getRadioGroup(FIELD.targetType, true);
  if (targetType !== "user" && targetType !== "role") {
    await interaction.reply(
      resultReply("Target required", "Choose whether this rule applies to a user or a role.", ephemeral, {
        ...opts,
        tone: "error",
      }),
    );
    return true;
  }

  let targetId: string | undefined;
  if (targetType === "user") {
    const users = interaction.fields.getSelectedUsers(FIELD.user) ?? null;
    targetId = users?.first()?.id;
    if (!targetId) {
      await interaction.reply(
        resultReply("User required", "Select a user for this rule.", ephemeral, { ...opts, tone: "error" }),
      );
      return true;
    }
  } else {
    const roles = interaction.fields.getSelectedRoles(FIELD.role) ?? null;
    targetId = roles?.first()?.id;
    if (!targetId) {
      await interaction.reply(
        resultReply("Role required", "Select a role for this rule.", ephemeral, { ...opts, tone: "error" }),
      );
      return true;
    }
  }

  const secondsRaw = interaction.fields.getTextInputValue(FIELD.seconds).trim();
  const seconds = Number(secondsRaw);
  if (!/^\d+$/.test(secondsRaw) || !Number.isInteger(seconds)) {
    await interaction.reply(
      resultReply("Invalid delay", "Enter the delay as a whole number of seconds (e.g. `6`).", ephemeral, {
        ...opts,
        tone: "error",
      }),
    );
    return true;
  }

  const channels = interaction.fields.getSelectedChannels(FIELD.channel) ?? null;
  const targetChannelId = channels?.first()?.id;

  const pluginConfig = resolvePluginConfig(guildConfig, "slowmode", defaults, guildMember, channelId, categoryId);
  const created = await createSlowmodeRule(configManager, interaction.guildId, interaction.user.id, pluginConfig, {
    target: targetType,
    targetId,
    seconds,
    channelId: targetChannelId,
  });

  if (!created.ok) {
    await interaction.reply(
      resultReply(created.title, created.message, ephemeral, { ...opts, tone: created.tone ?? "error" }),
    );
    return true;
  }

  await interaction.reply(
    resultReply("Slowmode rule added", formatSlowmodeRule(created.rule), ephemeral, {
      ...opts,
      emoji: "<:icons_new1:1544417349418094642>",
    }),
  );
  return true;
}
