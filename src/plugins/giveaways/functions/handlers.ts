import type { ButtonInteraction, Client, Message, MessageReaction, User } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { emojiKeysMatch } from "../../../core/emoji.js";
import { guildResultOptions, resultReply } from "../../../core/responses.js";
import { getLogger } from "../../../core/logger.js";
import { parseGiveawayClaimCustomId, parseGiveawayEnterCustomId } from "./customIds.js";
import { buildGiveawayComponents } from "./embeds.js";
import { claimWinner } from "./draw.js";
import { enterGiveaway, leaveGiveaway } from "./entries.js";
import * as store from "./store.js";
import type { Giveaway } from "./store.js";

const log = getLogger("giveaways");

// Cosmetic-only debounce for the entry-count button refresh. Losing this map on restart just
// means the count on the button is stale until the next entry, no correctness impact.
const refreshTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleEntryCountRefresh(message: Message, giveaway: Giveaway): void {
  if (refreshTimers.has(giveaway.id)) return;
  const timer = setTimeout(() => {
    refreshTimers.delete(giveaway.id);
    void (async () => {
      try {
        const fresh = await store.getGiveaway(giveaway.guildId, giveaway.id);
        if (!fresh || fresh.status !== "active") return;
        const count = await store.getEntryCount(giveaway.id);
        await message.edit({ components: buildGiveawayComponents(fresh, count) }).catch(() => null);
      } catch (error) {
        log.warn(`Failed to refresh entry count for giveaway #${giveaway.id}:`, error);
      }
    })();
  }, 10_000);
  refreshTimers.set(giveaway.id, timer);
}

export async function handleGiveawayEnterButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseGiveawayEnterCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "giveaways")) {
    await interaction.reply(
      resultReply("Plugin disabled", "Giveaways are disabled for this server.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const giveaway = await store.getGiveaway(interaction.guildId!, parsed.giveawayId);
  if (!giveaway || giveaway.status !== "active") {
    await interaction.reply(
      resultReply("Unavailable", "This giveaway is no longer active.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const result = await enterGiveaway(interaction.guild, giveaway, interaction.user.id);
  if (!result.ok) {
    await interaction.reply(resultReply("Cannot enter", result.reason, true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
    return true;
  }

  await interaction.reply(
    resultReply(
      result.entered ? "Entered" : "Already entered",
      result.entered ? `You're entered to win **${giveaway.prize}**.` : "You're already entered in this giveaway.",
      true,
      guildResultOptions(interaction.client, guildConfig, { tone: "success" }),
    ),
  );

  scheduleEntryCountRefresh(interaction.message, giveaway);
  return true;
}

export async function handleGiveawayClaimButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseGiveawayClaimCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const giveaway = await store.getGiveaway(interaction.guildId!, parsed.giveawayId);
  if (!giveaway) {
    await interaction.reply(
      resultReply("Not found", "This giveaway no longer exists.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const claimed = await claimWinner(giveaway, interaction.user.id);
  await interaction.reply(
    resultReply(
      claimed ? "Claimed" : "Cannot claim",
      claimed
        ? `You claimed **${giveaway.prize}**! Congratulations.`
        : "You don't have an unclaimed prize on this giveaway (already claimed, expired, or you didn't win).",
      true,
      guildResultOptions(interaction.client, guildConfig, { tone: claimed ? "success" : "error" }),
    ),
  );
  return true;
}

export async function handleGiveawayReaction(
  _client: Client,
  reaction: MessageReaction,
  user: User,
  action: "add" | "remove",
): Promise<void> {
  if (user.bot) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const message = reaction.message;
  if (!message.guild) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "giveaways")) return;

  const giveaway = await store.getGiveawayByMessageId(message.guild.id, message.id);
  if (!giveaway || giveaway.entryMethod !== "reaction") return;
  if (!emojiKeysMatch(giveaway.reactionEmoji, reaction.emoji)) return;

  if (action === "add") {
    await enterGiveaway(message.guild, giveaway, user.id).catch((error) => {
      log.warn(`Failed to register reaction entry for giveaway #${giveaway.id}:`, error);
    });
    return;
  }

  await leaveGiveaway(giveaway.id, user.id).catch((error) => {
    log.warn(`Failed to remove reaction entry for giveaway #${giveaway.id}:`, error);
  });
}
