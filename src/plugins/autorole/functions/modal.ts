import * as Discord from "discord.js";
import {
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { zAutoroleConfig } from "../../../config/schemas/autorole.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { hasPluginPermission, resolvePluginConfig } from "../../../core/permissions.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import {
  formatAutoroleEntry,
  getStoredAutoroleEntries,
  parseDelayInput,
  serializeAutoroleRoles,
  validateAutoroleTarget,
} from "./rules.js";

type AnyLabelBuilder = {
  setLabel(label: string): AnyLabelBuilder;
  setDescription(description: string): AnyLabelBuilder;
  setRoleSelectMenuComponent(input: unknown): AnyLabelBuilder;
  setTextInputComponent(input: unknown): AnyLabelBuilder;
};

const LabelBuilder = (Discord as unknown as { LabelBuilder: new () => AnyLabelBuilder }).LabelBuilder;

export const AUTOROLE_ADD_MODAL_ID = "dl:auto:add";

const FIELD = {
  role: "dl:auto:role",
  delay: "dl:auto:delay",
} as const;

export function buildAutoroleAddModal(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(AUTOROLE_ADD_MODAL_ID).setTitle("Add autorole");

  (modal as ModalBuilder & { addLabelComponents: (...args: unknown[]) => ModalBuilder }).addLabelComponents(
    new LabelBuilder()
      .setLabel("Role")
      .setDescription("Role to assign when a member joins.")
      .setRoleSelectMenuComponent(
        new RoleSelectMenuBuilder()
          .setCustomId(FIELD.role)
          .setPlaceholder("Select a role…")
          .setRequired(true)
          .setMinValues(1)
          .setMaxValues(1),
      ),
    new LabelBuilder()
      .setLabel("Delay")
      .setDescription("Optional wait before assigning. Use 0 or leave empty for immediate.")
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(FIELD.delay)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setPlaceholder("e.g. 0, 30s, 5m, 1h"),
      ),
  );

  return modal;
}

export async function createAutoroleEntry(
  configManager: ConfigManager,
  guild: Guild,
  guildId: string,
  userId: string,
  pluginConfig: Record<string, unknown>,
  input: { roleId: string; delayInput: string },
): Promise<{ ok: true; roleId: string; delayMs: number; delay?: string } | { ok: false; title: string; message: string; tone?: "error" | "warning" }> {
  const roleError = validateAutoroleTarget(guild, input.roleId);
  if (roleError) {
    return { ok: false, title: "Invalid role", message: roleError, tone: "error" };
  }

  const parsedDelay = parseDelayInput(input.delayInput);
  if (!parsedDelay.ok) {
    return { ok: false, title: "Invalid delay", message: parsedDelay.message, tone: "error" };
  }

  const config = zAutoroleConfig.parse(pluginConfig);
  const entries = getStoredAutoroleEntries(config);
  if (entries.some((entry) => entry.roleId === input.roleId)) {
    return { ok: false, title: "Already configured", message: "That role is already in the autorole list.", tone: "warning" };
  }

  const newEntry = {
    roleId: input.roleId,
    delayMs: parsedDelay.delayMs,
    ...(parsedDelay.delay ? { delay: parsedDelay.delay } : {}),
  };

  const result = await configManager.patchPluginConfig(
    guildId,
    "autorole",
    { roles: serializeAutoroleRoles([...entries, newEntry]) },
    userId,
  );
  if (!result.success) {
    return { ok: false, title: "Error", message: result.errors.join("\n"), tone: "error" };
  }

  return { ok: true, roleId: input.roleId, delayMs: parsedDelay.delayMs, ...(parsedDelay.delay ? { delay: parsedDelay.delay } : {}) };
}

export function formatCreatedAutoroleEntry(roleId: string, delayMs: number, delay?: string): string {
  return `Added ${formatAutoroleEntry(roleId, { delayMs, delay })}.`;
}

export async function handleAutoroleModalSubmit(
  interaction: ModalSubmitInteraction,
  configManager: ConfigManager,
): Promise<boolean> {
  if (interaction.customId !== AUTOROLE_ADD_MODAL_ID) return false;
  if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
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
  const defaults = getPluginDefaultOverrides("autorole");
  const ephemeral = resolveEphemeral(guildConfig);

  if (!hasPluginPermission(guildConfig, "autorole", "can_add", guildMember, channelId, categoryId, defaults)) {
    await interaction.reply(
      resultReply(
        "Permission denied",
        "You do not have permission to add autoroles.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const roles = interaction.fields.getSelectedRoles(FIELD.role);
  const role = roles?.first();
  if (!role) {
    await interaction.reply(
      resultReply("Role required", "Select a role to assign on join.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  let delayInput = "";
  try {
    delayInput = interaction.fields.getTextInputValue(FIELD.delay);
  } catch {
    delayInput = "";
  }

  const pluginConfig = resolvePluginConfig(guildConfig, "autorole", defaults, guildMember, channelId, categoryId);
  const created = await createAutoroleEntry(
    configManager,
    interaction.guild,
    interaction.guildId,
    interaction.user.id,
    pluginConfig,
    { roleId: role.id, delayInput },
  );

  if (!created.ok) {
    await interaction.reply(
      resultReply(created.title, created.message, ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: created.tone ?? "error" })),
    );
    return true;
  }

  await interaction.reply(
    resultReply(
      "Autorole added",
      formatCreatedAutoroleEntry(created.roleId, created.delayMs, created.delay),
      ephemeral,
      guildResultOptions(interaction.client, guildConfig),
    ),
  );
  return true;
}
