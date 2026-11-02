import type { ButtonInteraction, GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";
import { translatorFor } from "../../../i18n/index.js";
import { isInviteTrackerEnabled, PLUGIN, RESET_ALL_BUTTON } from "./config.js";
import { resetGuildCounts } from "./store.js";

/**
 * The "Reset everyone" confirmation from `/invites reset all`. Only the member who ran the
 * command can press it, and their can_manage grant is checked again at press time.
 */
export async function handleInviteTrackerButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(`${RESET_ALL_BUTTON}:`)) return false;
  const { t } = await translatorFor(interaction.user.id);
  const invokerId = interaction.customId.slice(RESET_ALL_BUTTON.length + 1);
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;
  if (!guild || !member || invokerId !== interaction.user.id) {
    await interaction.reply(resultReply(t("invite_tracker.title", "Invites"), t("invite_tracker.notYourButton", "This button isn't for you."), true));
    return true;
  }
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const options = guildResultOptions(interaction.client, guildConfig);
  if (!isInviteTrackerEnabled(guildConfig) || !(await hasPermission(guild.id, PLUGIN, "can_manage", member, guildConfig))) {
    await interaction.reply(
      resultReply(t("common.permissionDeniedTitle", "Permission denied"), t("common.noPermission", "You do not have permission to use this command."), true, {
        ...options,
        tone: "error",
      }),
    );
    return true;
  }
  resetGuildCounts(guild.id);
  await interaction.update(
    resultEdit(
      t("invite_tracker.resetTitle", "Invites reset"),
      t("invite_tracker.resetAllDone", "Everyone's invites are back to zero. Join history is kept."),
      { ...options, tone: "success" },
    ),
  );
  return true;
}
