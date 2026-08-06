import {
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Guild,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { GuildConfig } from "../../../../config/schemas/guild.js";
import { resultReply, guildResultOptions } from "../../../../core/responses.js";
import { isValidStatsWindow } from "../daily.js";
import { buildStatsPayload } from "./buildPayload.js";
import { parseCustomId, permissionForScope, STATS_PREFIX, type StatsState } from "./state.js";

export { STATS_PREFIX } from "./state.js";
export type { StatsScope, StatsState } from "./state.js";

export async function buildStatsMessage(
  state: StatsState,
  guild: Guild,
  client: Client,
  guildConfig: GuildConfig,
  ephemeral: boolean,
): Promise<InteractionReplyOptions> {
  const payload = await buildStatsPayload(state, guild, client, guildConfig);
  return {
    embeds: payload.embeds,
    files: payload.files,
    components: payload.components,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

export async function buildStatsUpdate(
  state: StatsState,
  guild: Guild,
  client: Client,
  guildConfig: GuildConfig,
): Promise<InteractionUpdateOptions> {
  const payload = await buildStatsPayload(state, guild, client, guildConfig);
  return { embeds: payload.embeds, files: payload.files, components: payload.components };
}

export async function handleStatsInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildConfig: GuildConfig,
  hasPermission: (permission: "can_server" | "can_user" | "can_channel") => boolean,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${STATS_PREFIX}:`)) return false;
  if (!interaction.inGuild() || !interaction.guild) return true;

  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return true;

  const required = permissionForScope(parsed.state.scope);
  if (!hasPermission(required)) {
    await interaction.reply(
      resultReply(
        "Permission denied",
        "You do not have permission to view these statistics.",
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

    await interaction.update(await buildStatsUpdate(nextState, interaction.guild, interaction.client, guildConfig));
  } catch (error) {
    console.error("Stats interaction error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            "Error",
            "Could not update statistics view.",
            true,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          ),
        )
        .catch(() => null);
    }
  }

  return true;
}
