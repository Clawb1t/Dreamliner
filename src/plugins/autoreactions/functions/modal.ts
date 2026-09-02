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
import { zAutoreactionTrigger, zAutoreactionsConfig } from "../../../config/schemas/plugins.js";
import { hasPermission, resolveEffectivePluginConfig } from "../../../core/permissionRoles.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { validateRegexPatternForSave } from "../../../core/regexSafety.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import {
  AUTOREACTION_ALL_CHANNELS,
  formatAutoreactionRule,
  nextAutoreactionRuleId,
  normalizeAutoreactionRules,
  resolveAutoreactionChannelId,
  type AutoreactionRule,
  type AutoreactionTrigger,
} from "./rules.js";
import { takePendingAutoreactionEmoji } from "./pending.js";

type AnyLabelBuilder = {
  setLabel(label: string): AnyLabelBuilder;
  setDescription(description: string): AnyLabelBuilder;
  setStringSelectMenuComponent(input: unknown): AnyLabelBuilder;
  setChannelSelectMenuComponent(input: unknown): AnyLabelBuilder;
  setTextInputComponent(input: unknown): AnyLabelBuilder;
};

// LabelBuilder exists at runtime in discord.js 14.26+ but is missing from the published typings.
// Must come from the same discord.js instance as the other builders (not @discordjs/builders).
const LabelBuilder = (Discord as unknown as { LabelBuilder: new () => AnyLabelBuilder }).LabelBuilder;

export const AUTOREACTION_ADD_MODAL_ID = "dl:ar:add";

const FIELD = {
  trigger: "dl:ar:trigger",
  match: "dl:ar:match",
  channel: "dl:ar:channel",
  extras: "dl:ar:extras",
} as const;

const TRIGGER_OPTIONS = [
  {
    label: "Every message",
    value: "every_message",
    description: "React to all messages in scope",
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
  { label: "Every 25th match", value: "every_25", description: "Sparse reactions" },
  { label: "30s cooldown", value: "cd_30", description: "At most once per 30 seconds" },
  { label: "1 minute cooldown", value: "cd_60", description: "At most once per minute" },
  { label: "5 minute cooldown", value: "cd_300", description: "At most once per 5 minutes" },
  { label: "Attachments only", value: "attachments", description: "Only messages with files/images" },
  { label: "Links only", value: "links", description: "Only messages containing links" },
] as const;

function formatChannelLabel(channelId: string): string {
  return channelId === AUTOREACTION_ALL_CHANNELS ? "All channels" : `<#${channelId}>`;
}

export function buildAutoreactionAddModal(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(AUTOREACTION_ADD_MODAL_ID).setTitle("Add auto-reaction");

  // Cast: discord.js typings lag behind LabelBuilder support.
  (modal as ModalBuilder & { addLabelComponents: (...args: unknown[]) => ModalBuilder }).addLabelComponents(
    new LabelBuilder()
      .setLabel("When should it react?")
      .setDescription("Choose how messages are matched. Emoji comes from the /autoreaction add command.")
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
          .setPlaceholder("e.g. hello   or   ^pog"),
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

function parseExtras(values: readonly string[]): Pick<AutoreactionRule, "every_n" | "cooldown_seconds" | "attachments_only" | "links_only"> {
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

export async function createAutoreactionRule(
  configManager: ConfigManager,
  guildId: string,
  userId: string,
  pluginConfig: Record<string, unknown>,
  input: {
    emoji: string;
    trigger: AutoreactionTrigger;
    match?: string;
    channelId?: string;
    extras: readonly string[];
  },
): Promise<{ ok: true; rule: AutoreactionRule } | { ok: false; title: string; message: string; tone?: "error" | "warning" }> {
  const emoji = input.emoji.trim();
  if (!emoji) {
    return { ok: false, title: "Emoji required", message: "Provide an emoji to react with.", tone: "error" };
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

  const config = zAutoreactionsConfig.parse(pluginConfig);
  const rules = normalizeAutoreactionRules(config.rules);
  const channelId = resolveAutoreactionChannelId(input.channelId);
  const extras = parseExtras(input.extras);

  const newRule: AutoreactionRule = {
    id: nextAutoreactionRuleId(rules),
    channel_id: channelId,
    emoji,
    trigger: input.trigger,
    ...(matchRaw ? { match: matchRaw } : {}),
    ...extras,
  };

  const duplicate = rules.some(
    (rule) =>
      rule.channel_id === newRule.channel_id &&
      rule.emoji === newRule.emoji &&
      rule.trigger === newRule.trigger &&
      (rule.match ?? "") === (newRule.match ?? "") &&
      (rule.every_n ?? null) === (newRule.every_n ?? null) &&
      (rule.cooldown_seconds ?? null) === (newRule.cooldown_seconds ?? null) &&
      Boolean(rule.attachments_only) === Boolean(newRule.attachments_only) &&
      Boolean(rule.links_only) === Boolean(newRule.links_only),
  );
  if (duplicate) {
    return { ok: false, title: "Already exists", message: "That auto-reaction rule already exists.", tone: "warning" };
  }

  const result = await configManager.patchPluginConfig(guildId, "autoreactions", { rules: [...rules, newRule] }, userId);
  if (!result.success) {
    return { ok: false, title: "Error", message: result.errors.join("\n"), tone: "error" };
  }

  return { ok: true, rule: newRule };
}

export function formatCreatedRule(rule: AutoreactionRule): string {
  return `Rule **#${rule.id}**: react with ${rule.emoji} in ${formatChannelLabel(rule.channel_id)} · ${formatAutoreactionRule(rule)}.`;
}

export async function handleAutoreactionModalSubmit(
  interaction: ModalSubmitInteraction,
  configManager: ConfigManager,
): Promise<boolean> {
  if (interaction.customId !== AUTOREACTION_ADD_MODAL_ID) return false;
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
  const ephemeral = resolveEphemeral(guildConfig);

  if (!(await hasPermission(interaction.guildId, "autoreactions", "can_add", guildMember, guildConfig))) {
    await interaction.reply(
      resultReply("Permission denied", "You do not have permission to add auto-reactions.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const triggerRaw = interaction.fields.getStringSelectValues(FIELD.trigger)[0];
  const parsedTrigger = zAutoreactionTrigger.safeParse(triggerRaw);
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

  const emoji = takePendingAutoreactionEmoji(interaction.guildId, interaction.user.id);
  if (!emoji) {
    await interaction.reply(
      resultReply(
        "Emoji missing",
        "Run `/autoreaction add` again and choose an emoji in the command option.",
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

  const pluginConfig = await resolveEffectivePluginConfig(interaction.guildId, "autoreactions", guildMember, guildConfig);
  const created = await createAutoreactionRule(configManager, interaction.guildId, interaction.user.id, pluginConfig, {
    emoji,
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
      "Auto-reaction added",
      formatCreatedRule(created.rule),
      ephemeral,
      guildResultOptions(interaction.client, guildConfig, { emoji: "<:icons_addreactions:1544417680327704607>" }),
    ),
  );
  return true;
}
