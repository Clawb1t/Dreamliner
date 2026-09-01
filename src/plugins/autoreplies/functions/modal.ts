import * as Discord from "discord.js";
import {
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { zAutorepliesConfig, zAutoreplyTrigger } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { hasPluginPermission, resolvePluginConfig } from "../../../core/permissions.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { validateRegexPatternForSave } from "../../../core/regexSafety.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import {
  formatAutoreplyRule,
  nextAutoreplyRuleId,
  normalizeAutoreplyRules,
  type AutoreplyRule,
  type AutoreplyTrigger,
} from "./rules.js";
import { takePendingAutoreplyResponse } from "./pending.js";

type AnyLabelBuilder = {
  setLabel(label: string): AnyLabelBuilder;
  setDescription(description: string): AnyLabelBuilder;
  setStringSelectMenuComponent(input: unknown): AnyLabelBuilder;
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

export const AUTOREPLY_ADD_MODAL_ID = "dl:ap:add";

const FIELD = {
  trigger: "dl:ap:trigger",
  match: "dl:ap:match",
  sendAs: "dl:ap:send_as",
  channel: "dl:ap:channel",
  extras: "dl:ap:extras",
} as const;

const ALL_CHANNELS = "*";

const TRIGGER_OPTIONS = [
  {
    label: "Every message",
    value: "every_message",
    description: "Reply to all messages in scope",
  },
  {
    label: "Contains text",
    value: "contains",
    description: "Message includes your match text",
  },
  {
    label: "Starts with text",
    value: "starts_with",
    description: "Message begins with your match text",
  },
  {
    label: "Exact message",
    value: "exact",
    description: "Whole message equals your match text",
  },
  {
    label: "Regex match",
    value: "regex",
    description: "Advanced pattern matching",
  },
] as const;

const EXTRA_OPTIONS = [
  { label: "Every 5th match", value: "every_5", description: "Only the 5th, 10th, 15th…" },
  { label: "Every 10th match", value: "every_10", description: "Only every 10 matching messages" },
  { label: "Every 25th match", value: "every_25", description: "Sparse replies" },
  { label: "30s cooldown", value: "cd_30", description: "At most once per 30 seconds" },
  { label: "1 minute cooldown", value: "cd_60", description: "At most once per minute" },
  { label: "5 minute cooldown", value: "cd_300", description: "At most once per 5 minutes" },
  { label: "Attachments only", value: "attachments", description: "Only messages with files/images" },
  { label: "Links only", value: "links", description: "Only messages containing links" },
] as const;

function formatChannelLabel(channelId: string): string {
  return channelId === ALL_CHANNELS ? "All channels" : `<#${channelId}>`;
}

export function buildAutoreplyAddModal(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(AUTOREPLY_ADD_MODAL_ID).setTitle("Add auto-reply");

  (modal as ModalBuilder & { addLabelComponents: (...args: unknown[]) => ModalBuilder }).addLabelComponents(
    new LabelBuilder()
      .setLabel("When should it reply?")
      .setDescription("Choose how messages are matched. Reply text comes from the /autoreply add command.")
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(FIELD.trigger)
          .setPlaceholder("Choose a trigger…")
          .setRequired(true)
          .addOptions(...TRIGGER_OPTIONS),
      ),
    new LabelBuilder()
      .setLabel("Match text")
      .setDescription("Required for contains / starts with / exact / regex. Leave empty for every message.")
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(FIELD.match)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder("e.g. hello   or   ^help"),
      ),
    new LabelBuilder()
      .setLabel("How should it send?")
      .setDescription("Reply to the trigger message, or just post afterward in the channel.")
      .setRadioGroupComponent(
        new RadioGroupBuilder()
          .setCustomId(FIELD.sendAs)
          .setRequired(true)
          .addOptions(
            new RadioGroupOptionBuilder()
              .setValue("reply")
              .setLabel("Reply to the message")
              .setDescription("Send as a Discord reply on the trigger")
              .setDefault(true),
            new RadioGroupOptionBuilder()
              .setValue("send")
              .setLabel("Send after the trigger")
              .setDescription("Post a normal message in the channel"),
          ),
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
    new LabelBuilder()
      .setLabel("Extras")
      .setDescription("Optional cadence and filters. Pick up to 3.")
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(FIELD.extras)
          .setPlaceholder("No extras")
          .setRequired(false)
          .setMinValues(0)
          .setMaxValues(3)
          .addOptions(...EXTRA_OPTIONS),
      ),
  );

  return modal;
}

function parseExtras(
  values: readonly string[],
): Pick<AutoreplyRule, "every_n" | "cooldown_seconds" | "attachments_only" | "links_only"> {
  let everyN: number | undefined;
  let cooldown: number | undefined;
  let attachmentsOnly = false;
  let linksOnly = false;

  for (const value of values) {
    if (value === "every_5") everyN = everyN ? Math.min(everyN, 5) : 5;
    else if (value === "every_10") everyN = everyN ? Math.min(everyN, 10) : 10;
    else if (value === "every_25") everyN = everyN ? Math.min(everyN, 25) : 25;
    else if (value === "cd_30") cooldown = cooldown ? Math.min(cooldown, 30) : 30;
    else if (value === "cd_60") cooldown = cooldown ? Math.min(cooldown, 60) : 60;
    else if (value === "cd_300") cooldown = cooldown ? Math.min(cooldown, 300) : 300;
    else if (value === "attachments") attachmentsOnly = true;
    else if (value === "links") linksOnly = true;
  }

  return {
    ...(everyN ? { every_n: everyN } : {}),
    ...(cooldown ? { cooldown_seconds: cooldown } : {}),
    ...(attachmentsOnly ? { attachments_only: true } : {}),
    ...(linksOnly ? { links_only: true } : {}),
  };
}

export async function createAutoreplyRule(
  configManager: ConfigManager,
  guildId: string,
  userId: string,
  pluginConfig: Record<string, unknown>,
  input: {
    response: string;
    replyToMessage: boolean;
    trigger: AutoreplyTrigger;
    match?: string;
    channelId?: string;
    extras: readonly string[];
  },
): Promise<{ ok: true; rule: AutoreplyRule } | { ok: false; title: string; message: string; tone?: "error" | "warning" }> {
  const response = input.response.trim();
  if (!response) {
    return { ok: false, title: "Message required", message: "Provide a reply message.", tone: "error" };
  }
  if (response.length > 2000) {
    return { ok: false, title: "Message too long", message: "Reply messages must be 2000 characters or fewer.", tone: "error" };
  }

  const matchRaw = input.match?.trim();
  if (input.trigger !== "every_message" && !matchRaw) {
    return {
      ok: false,
      title: "Match required",
      message: `Trigger **${TRIGGER_OPTIONS.find((o) => o.value === input.trigger)?.label ?? input.trigger}** needs match text.`,
      tone: "error",
    };
  }

  if (input.trigger === "regex" && matchRaw) {
    const validation = await validateRegexPatternForSave(matchRaw, "i");
    if (!validation.ok) {
      return { ok: false, title: "Invalid regex", message: validation.error, tone: "error" };
    }
  }

  const config = zAutorepliesConfig.parse(pluginConfig);
  const rules = normalizeAutoreplyRules(config.rules);
  const channelId = input.channelId?.trim() || ALL_CHANNELS;
  const extras = parseExtras(input.extras);

  const newRule: AutoreplyRule = {
    id: nextAutoreplyRuleId(rules),
    channel_id: channelId,
    response,
    trigger: input.trigger,
    reply_to_message: input.replyToMessage,
    ...(matchRaw ? { match: matchRaw } : {}),
    ...extras,
  };

  const duplicate = rules.some(
    (rule) =>
      rule.channel_id === newRule.channel_id &&
      rule.response === newRule.response &&
      rule.trigger === newRule.trigger &&
      (rule.match ?? "") === (newRule.match ?? "") &&
      (rule.every_n ?? null) === (newRule.every_n ?? null) &&
      (rule.cooldown_seconds ?? null) === (newRule.cooldown_seconds ?? null) &&
      Boolean(rule.attachments_only) === Boolean(newRule.attachments_only) &&
      Boolean(rule.links_only) === Boolean(newRule.links_only) &&
      (rule.reply_to_message !== false) === (newRule.reply_to_message !== false),
  );
  if (duplicate) {
    return { ok: false, title: "Already exists", message: "That auto-reply rule already exists.", tone: "warning" };
  }

  const result = await configManager.patchPluginConfig(guildId, "autoreplies", { rules: [...rules, newRule] }, userId);
  if (!result.success) {
    return { ok: false, title: "Error", message: result.errors.join("\n"), tone: "error" };
  }

  return { ok: true, rule: newRule };
}

export function formatCreatedAutoreplyRule(rule: AutoreplyRule): string {
  const preview = rule.response.length > 80 ? `${rule.response.slice(0, 77)}…` : rule.response;
  return `Rule **#${rule.id}**: \`${preview}\` in ${formatChannelLabel(rule.channel_id)} · ${formatAutoreplyRule(rule)}.`;
}

export async function handleAutoreplyModalSubmit(
  interaction: ModalSubmitInteraction,
  configManager: ConfigManager,
): Promise<boolean> {
  if (interaction.customId !== AUTOREPLY_ADD_MODAL_ID) return false;
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
  const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
  const defaults = getPluginDefaultOverrides("autoreplies");
  const ephemeral = resolveEphemeral(guildConfig);

  if (!hasPluginPermission(guildConfig, "autoreplies", "can_add", guildMember, channelId, categoryId, defaults)) {
    await interaction.reply(
      resultReply("Permission denied", "You do not have permission to add auto-replies.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const triggerRaw = interaction.fields.getStringSelectValues(FIELD.trigger)[0];
  const parsedTrigger = zAutoreplyTrigger.safeParse(triggerRaw);
  if (!parsedTrigger.success) {
    await interaction.reply(
      resultReply("Invalid trigger", "Choose a valid trigger from the dropdown.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  let match = "";
  try {
    match = interaction.fields.getTextInputValue(FIELD.match);
  } catch {
    match = "";
  }

  const response = takePendingAutoreplyResponse(interaction.guildId, interaction.user.id);
  if (!response) {
    await interaction.reply(
      resultReply(
        "Message missing",
        "Run `/autoreply add` again and provide the reply message in the command option.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const sendAs = interaction.fields.getRadioGroup(FIELD.sendAs, true);
  if (sendAs !== "reply" && sendAs !== "send") {
    await interaction.reply(
      resultReply(
        "Send mode required",
        "Choose whether to reply to the message or send after the trigger.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const channels = interaction.fields.getSelectedChannels(FIELD.channel) ?? null;
  const targetChannelId = channels?.first()?.id;
  let extras: readonly string[] = [];
  try {
    extras = interaction.fields.getStringSelectValues(FIELD.extras);
  } catch {
    extras = [];
  }

  const pluginConfig = resolvePluginConfig(guildConfig, "autoreplies", defaults, guildMember, channelId, categoryId);
  const created = await createAutoreplyRule(configManager, interaction.guildId, interaction.user.id, pluginConfig, {
    response,
    replyToMessage: sendAs === "reply",
    trigger: parsedTrigger.data,
    match,
    channelId: targetChannelId,
    extras,
  });

  if (!created.ok) {
    await interaction.reply(
      resultReply(created.title, created.message, ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: created.tone ?? "error" })),
    );
    return true;
  }

  await interaction.reply(
    resultReply(
      "Auto-reply added",
      formatCreatedAutoreplyRule(created.rule),
      ephemeral,
      guildResultOptions(interaction.client, guildConfig, { emoji: "<:icons_reply:1544417399879770265>" }),
    ),
  );
  return true;
}
