import {
  ActionRowBuilder,
  CheckboxBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import { APPEAL_EMOJIS, type AppealsConfig } from "../../../config/schemas/appeals.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import type { EmbedTone } from "../../../core/embeds.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";
import {
  APPEAL_REVERSE_FIELD_ID,
  APPEAL_TEXT_FIELD_ID,
  appealModalId,
  parseAppealCustomId,
  type AppealAction,
} from "../constants.js";
import { loadAppealsConfig, PLUGIN, ruleFor } from "./config.js";
import { addAppealNote, decideAppeal, requestAppealInfo } from "./service.js";
import { getAppeal } from "./store.js";

type Ctx = { guildConfig: GuildConfig; config: AppealsConfig; member: GuildMember };

async function reply(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: Pick<Ctx, "guildConfig">,
  title: string,
  body: string,
  tone: EmbedTone,
  emoji?: string,
): Promise<void> {
  const options = guildResultOptions(interaction.client, ctx.guildConfig, { tone, ...(emoji ? { emoji } : {}) });
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(resultEdit(title, body, options));
    return;
  }
  await interaction.reply(resultReply(title, body, true, options));
}

async function resolveContext(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<Ctx | null> {
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) return null;
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, PLUGIN)) {
    await interaction.reply(resultReply("Appeals are off", "Appeals are turned off for this server.", true));
    return null;
  }
  const member = interaction.member as GuildMember;
  if (!(await hasPermission(interaction.guildId, PLUGIN, "can_review", member, guildConfig))) {
    await interaction.reply(
      resultReply("No permission", "You don't have permission to review appeals.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return null;
  }
  return { guildConfig, config: loadAppealsConfig(guildConfig), member };
}

/** The modal each review button opens: a note (approve), a reason (deny) or a question (info). */
function buildActionModal(action: AppealAction, appealId: number, config: AppealsConfig, liftByDefault: boolean): ModalBuilder {
  const titles: Record<AppealAction, string> = {
    approve: `Approve appeal #${appealId}`,
    deny: `Deny appeal #${appealId}`,
    info: `Ask about appeal #${appealId}`,
    note: `Note on appeal #${appealId}`,
  };
  const labels: Record<AppealAction, string> = {
    approve: "Note for the user (optional)",
    deny: config.review.require_deny_reason ? "Reason (sent to the user)" : "Reason (optional, sent to the user)",
    info: "Your question (sent to the user)",
    note: "Staff note (the user never sees it)",
  };
  const required = action === "info" || action === "note" || (action === "deny" && config.review.require_deny_reason);
  const modal = new ModalBuilder()
    .setCustomId(appealModalId(action, appealId))
    .setTitle(titles[action].slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(APPEAL_TEXT_FIELD_ID)
          .setLabel(labels[action])
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(required)
          .setMaxLength(1000),
      ),
    );
  if (action === "approve") {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel("Lift the punishment")
        .setDescription("Unban, remove the timeout, or revoke the case.")
        .setCheckboxComponent(new CheckboxBuilder().setCustomId(APPEAL_REVERSE_FIELD_ID).setDefault(liftByDefault)),
    );
  }
  return modal;
}

export async function handleAppealButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseAppealCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "button") return false;
  const ctx = await resolveContext(interaction);
  if (!ctx) return true;
  const appeal = getAppeal(interaction.guildId!, parsed.appealId);
  if (!appeal) {
    await reply(interaction, ctx, "Appeal not found", "This appeal no longer exists.", "warning");
    return true;
  }
  const liftByDefault = appeal.kind === "manual" ? true : (ruleFor(ctx.config, appeal.infractionType ?? "")?.auto_reverse ?? true);
  await interaction.showModal(buildActionModal(parsed.action, appeal.id, ctx.config, liftByDefault));
  return true;
}

export async function handleAppealModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
  const parsed = parseAppealCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "modal") return false;
  const ctx = await resolveContext(interaction);
  if (!ctx) return true;
  await interaction.deferReply({ ephemeral: true });

  const text = interaction.fields.getTextInputValue(APPEAL_TEXT_FIELD_ID).trim() || null;
  const guild = interaction.guild!;

  if (parsed.action === "note") {
    const result = await addAppealNote(guild, ctx.config, parsed.appealId, interaction.user.id, text ?? "");
    if (!result.ok) await reply(interaction, ctx, "Couldn't add the note", result.error, "warning");
    else await reply(interaction, ctx, "Note added", "Saved to the appeal's timeline. Only staff can see it.", "neutral", APPEAL_EMOJIS.note);
    return true;
  }

  if (parsed.action === "info") {
    const result = await requestAppealInfo(guild, ctx.guildConfig, ctx.config, parsed.appealId, interaction.user.id, text ?? "");
    if (!result.ok) await reply(interaction, ctx, "Couldn't ask", result.error, "warning");
    else
      await reply(
        interaction,
        ctx,
        "Question sent",
        [`<@${result.appeal.userId}> can answer it on their appeal page.`, ...result.notes].join("\n"),
        "neutral",
        APPEAL_EMOJIS.needsInfo,
      );
    return true;
  }

  const decision = parsed.action === "approve" ? "approved" : "denied";
  let reverse = false;
  if (decision === "approved") {
    try {
      reverse = interaction.fields.getCheckbox(APPEAL_REVERSE_FIELD_ID);
    } catch {
      reverse = true;
    }
  }
  const result = await decideAppeal(guild, ctx.guildConfig, ctx.config, parsed.appealId, decision, interaction.user.id, text, reverse);
  if (!result.ok) {
    await reply(interaction, ctx, "Couldn't decide it", result.error, "warning");
    return true;
  }
  const body = [
    `Appeal **#${result.appeal.id}** from <@${result.appeal.userId}> was ${decision}.`,
    result.appeal.reversalNote ?? "",
    ...result.notes,
  ]
    .filter(Boolean)
    .join("\n");
  await reply(
    interaction,
    ctx,
    decision === "approved" ? "Appeal approved" : "Appeal denied",
    body,
    decision === "approved" ? "success" : "neutral",
    decision === "approved" ? APPEAL_EMOJIS.approved : APPEAL_EMOJIS.denied,
  );
  return true;
}
