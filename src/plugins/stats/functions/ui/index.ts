import {
  type ButtonInteraction,
  type Client,
  type Guild,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type StringSelectMenuInteraction,
} from "discord.js";
import { canViewStatsChannel } from "./channelAccess.js";
import type { GuildConfig } from "../../../../config/schemas/guild.js";
import { containerEdit, containerReply, resultReply, guildResultOptions } from "../../../../core/responses.js";
import { isValidStatsWindow } from "../daily.js";
import { buildStatsPayload, type ChartUpgrade } from "./buildPayload.js";
import { claimMessageView, upgradeToGif } from "../animatedReply.js";
import { parseCustomId, permissionForScope, STATS_PREFIX, type StatsState } from "./state.js";
import { getLogger } from "../../../../core/logger.js";
import { defaultTranslator, translatorFor, type Translator } from "../../../../i18n/index.js";
const log = getLogger("stats");

export { STATS_PREFIX } from "./state.js";
export type { StatsScope, StatsState } from "./state.js";

export async function buildStatsMessage(
  state: StatsState,
  guild: Guild,
  client: Client,
  guildConfig: GuildConfig,
  ephemeral: boolean,
  t: Translator = defaultTranslator,
): Promise<InteractionReplyOptions & { chartUpgrade?: ChartUpgrade }> {
  const payload = await buildStatsPayload(state, guild, client, guildConfig, t);
  return { ...containerReply(payload.embed, ephemeral, payload.rows), files: payload.files, chartUpgrade: payload.chartUpgrade };
}

export async function buildStatsUpdate(
  state: StatsState,
  guild: Guild,
  client: Client,
  guildConfig: GuildConfig,
  t: Translator = defaultTranslator,
): Promise<{ update: InteractionUpdateOptions; chartUpgrade?: ChartUpgrade }> {
  const payload = await buildStatsPayload(state, guild, client, guildConfig, t);
  return { update: { ...containerEdit(payload.embed, payload.rows), files: payload.files }, chartUpgrade: payload.chartUpgrade };
}

export async function handleStatsInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildConfig: GuildConfig,
  hasPermission: (permission: "can_server" | "can_user" | "can_channel") => Promise<boolean>,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${STATS_PREFIX}:`)) return false;
  if (!interaction.inGuild() || !interaction.guild) return true;

  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return true;

  const { t } = await translatorFor(interaction.user.id);

  const required = permissionForScope(parsed.state.scope);
  const channelHidden =
    parsed.state.scope.type === "channel" && !(await canViewStatsChannel(interaction.guild, parsed.state.scope.channelId, interaction.user.id));
  if (channelHidden || !(await hasPermission(required))) {
    await interaction.reply(
      resultReply(
        t("stats.permissionDeniedTitle", "Permission denied"),
        t("stats.permissionDeniedDesc", "You do not have permission to view these statistics."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  try {
    let nextState = parsed.state;

    if (interaction.isStringSelectMenu()) {
      const value = interaction.values[0];
      if (!value) return true;
      if (parsed.action === "cat") {
        nextState = { ...parsed.state, category: value, chartPage: 0 };
      } else if (parsed.action === "days") {
        const days = Number(value);
        if (isValidStatsWindow(days)) {
          nextState = { ...parsed.state, days, chartPage: 0 };
        }
      }
    }

    // A newer view of this message makes any GIF still rendering for an older one stale.
    const isCurrent = claimMessageView(interaction.message.id);
    const { update, chartUpgrade } = await buildStatsUpdate(nextState, interaction.guild, interaction.client, guildConfig, t);
    await interaction.update(update);
    // An animated leaderboard: the still is up, the GIF replaces it when ready.
    if (chartUpgrade) {
      await upgradeToGif((options) => interaction.editReply(options), chartUpgrade.render, "chart", chartUpgrade.payload(), isCurrent);
    }
  } catch (error) {
    log.error("Stats interaction error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            t("stats.errorTitle", "Error"),
            t("stats.errorUpdatingView", "Could not update statistics view."),
            true,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          ),
        )
        .catch(() => null);
    }
  }

  return true;
}
