import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type Client, type Guild, type MessageActionRowComponentBuilder, type MessageReaction, type User } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { emojiKeysMatch, parseComponentEmoji } from "../../../core/emoji.js";
import { guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";
import { getLogger } from "../../../core/logger.js";
import { translatorFor } from "../../../i18n/index.js";
import { buildGiveawayLeaveCustomId, parseGiveawayClaimCustomId, parseGiveawayEnterCustomId, parseGiveawayLeaveCustomId } from "./customIds.js";
import { claimWinner } from "./draw.js";
import { enterGiveaway, leaveGiveaway } from "./entries.js";
import { refreshGiveawayMessage } from "./lifecycle.js";
import { GIVEAWAY_EMOJI } from "./message.js";
import * as store from "./store.js";

const log = getLogger("giveaways");

// Debounces the live entry count on the post: one edit per giveaway every few seconds at most,
// however many people enter. Losing this on restart only delays the count until the next entry.
const refreshTimers = new Map<number, ReturnType<typeof setTimeout>>();
const REFRESH_DELAY_MS = 5_000;

export function scheduleEntryCountRefresh(guild: Guild, giveawayId: number): void {
  if (refreshTimers.has(giveawayId)) return;
  const timer = setTimeout(() => {
    refreshTimers.delete(giveawayId);
    void (async () => {
      try {
        const fresh = await store.getGiveaway(guild.id, giveawayId);
        if (!fresh || (fresh.status !== "active" && fresh.status !== "paused")) return;
        await refreshGiveawayMessage(guild, fresh);
      } catch (error) {
        log.warn(`Failed to refresh the entry count for giveaway #${giveawayId}:`, error);
      }
    })();
  }, REFRESH_DELAY_MS);
  timer.unref?.();
  refreshTimers.set(giveawayId, timer);
}

/** The ephemeral "Leave giveaway" button under the entered / already-entered replies. */
function leaveRow(giveawayId: number, label: string): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const button = new ButtonBuilder().setCustomId(buildGiveawayLeaveCustomId(giveawayId)).setStyle(ButtonStyle.Danger).setLabel(label);
  const emoji = parseComponentEmoji(GIVEAWAY_EMOJI.cross);
  if (emoji && typeof emoji !== "string") button.setEmoji(emoji);
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button)];
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export async function handleGiveawayEnterButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseGiveawayEnterCustomId(interaction.customId);
  if (!parsed) return false;
  const { t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply(t("common.serverOnlyTitle", "Server only"), t("common.serverOnlyBody", "This command can only be used in a server."), true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const options = (tone: "success" | "error" | "warning") => guildResultOptions(interaction.client, guildConfig, { tone });
  if (!pluginEnabled(guildConfig, "giveaways")) {
    await interaction.reply(resultReply(t("giveaways.disabledTitle", "Giveaways are off"), t("giveaways.disabledBody", "Giveaways are turned off in this server."), true, options("error")));
    return true;
  }

  const giveaway = await store.getGiveaway(interaction.guildId!, parsed.giveawayId);
  if (!giveaway) {
    await interaction.reply(resultReply(t("giveaways.goneTitle", "Giveaway not found"), t("giveaways.goneBody", "This giveaway no longer exists."), true, options("error")));
    return true;
  }

  const result = await enterGiveaway(interaction.guild, giveaway, interaction.user.id);
  if (!result.ok) {
    await interaction.reply(resultReply(t("giveaways.cantEnterTitle", "You can't enter yet"), result.reason, true, options("error")));
    return true;
  }

  const leaveLabel = t("giveaways.leaveButton", "Leave giveaway");
  if (result.action === "left") {
    // Only reachable with { toggle: true }, which the button no longer uses.
    await interaction.reply(resultReply(t("giveaways.leftTitle", "You left the giveaway"), "", true, options("warning")));
  } else if (result.action === "entered") {
    const extra = result.weight !== 1 ? t("giveaways.enteredWeight", "You have **{entries}** in the draw.", { entries: plural(result.weight, "entry", "entries") }) : "";
    await interaction.reply(
      resultReply(
        t("giveaways.enteredTitle", "You're in!"),
        [
          t("giveaways.enteredBody", "You're entered to win **{prize}**. Winners are drawn <t:{ends}:R>.", {
            prize: giveaway.prize,
            ends: Math.floor(giveaway.endsAt.getTime() / 1000),
          }),
          extra,
          t("giveaways.enteredLeaveHint", "Changed your mind? You can leave below."),
        ]
          .filter(Boolean)
          .join("\n"),
        true,
        options("success"),
        leaveRow(giveaway.id, leaveLabel),
      ),
    );
  } else {
    await interaction.reply(
      resultReply(
        t("giveaways.alreadyTitle", "Already entered"),
        t("giveaways.alreadyBody2", "You're already entered to win **{prize}**. Want out? Leave below.", { prize: giveaway.prize }),
        true,
        options("success"),
        leaveRow(giveaway.id, leaveLabel),
      ),
    );
    return true;
  }

  scheduleEntryCountRefresh(interaction.guild, giveaway.id);
  return true;
}

export async function handleGiveawayLeaveButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseGiveawayLeaveCustomId(interaction.customId);
  if (!parsed) return false;
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guild) return true;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const options = (tone: "success" | "error" | "warning") => guildResultOptions(interaction.client, guildConfig, { tone });
  const giveaway = await store.getGiveaway(interaction.guildId!, parsed.giveawayId);
  const reply = (title: string, body: string, tone: "success" | "error" | "warning") =>
    interaction.update(resultEdit(title, body, options(tone), []) as Parameters<ButtonInteraction["update"]>[0]);

  if (!giveaway) {
    await reply(t("giveaways.goneTitle", "Giveaway not found"), t("giveaways.goneBody", "This giveaway no longer exists."), "error");
    return true;
  }
  // Running and paused giveaways can be left; once it's drawing or over, entries are part of the record.
  if (giveaway.status !== "active" && giveaway.status !== "paused") {
    await reply(t("giveaways.cantLeaveTitle", "Can't leave now"), t("giveaways.cantLeaveBody", "This giveaway has already ended, so entries are final."), "error");
    return true;
  }
  const entry = await store.getEntry(giveaway.id, interaction.user.id);
  if (!entry) {
    await reply(t("giveaways.notEnteredTitle", "Not entered"), t("giveaways.notEnteredBody", "You're not entered in this giveaway."), "warning");
    return true;
  }

  const refunded = await leaveGiveaway(giveaway, interaction.user.id);
  await reply(
    t("giveaways.leftTitle", "You left the giveaway"),
    [
      t("giveaways.leftBody2", "You're no longer entered to win **{prize}**. Press Enter on the giveaway to rejoin.", { prize: giveaway.prize }),
      refunded > 0 ? t("giveaways.leftRefund", "Your entry cost was refunded.") : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "warning",
  );
  scheduleEntryCountRefresh(interaction.guild, giveaway.id);
  return true;
}

export async function handleGiveawayClaimButton(interaction: ButtonInteraction): Promise<boolean> {
  const parsed = parseGiveawayClaimCustomId(interaction.customId);
  if (!parsed) return false;
  const { t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply(t("common.serverOnlyTitle", "Server only"), t("common.serverOnlyBody", "This command can only be used in a server."), true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const giveaway = await store.getGiveaway(interaction.guildId!, parsed.giveawayId);
  if (!giveaway) {
    await interaction.reply(
      resultReply(t("giveaways.goneTitle", "Giveaway not found"), t("giveaways.goneBody", "This giveaway no longer exists."), true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const claimed = await claimWinner(giveaway, interaction.user.id);
  const body = claimed.ok
    ? t("giveaways.claimedBody", "You claimed **{prize}**. Congratulations! Staff will be in touch about your prize.", { prize: giveaway.prize })
    : claimed.reason === "already_claimed"
      ? t("giveaways.claimAlready", "You've already claimed this prize.")
      : claimed.reason === "expired"
        ? t("giveaways.claimExpired", "The time to claim this prize has run out.")
        : t("giveaways.claimNotWinner", "Only a winner of this giveaway can claim it.");
  await interaction.reply(
    resultReply(
      claimed.ok ? t("giveaways.claimedTitle", "Prize claimed") : t("giveaways.cantClaimTitle", "Can't claim"),
      body,
      true,
      guildResultOptions(interaction.client, guildConfig, { tone: claimed.ok ? "success" : "error" }),
    ),
  );
  if (claimed.ok) await refreshGiveawayMessage(interaction.guild, giveaway).catch(() => null);
  return true;
}

export async function handleGiveawayReaction(_client: Client, reaction: MessageReaction, user: User, action: "add" | "remove"): Promise<void> {
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

  try {
    if (action === "add") {
      const result = await enterGiveaway(message.guild, giveaway, user.id);
      if (!result.ok) {
        // Take the reaction back off so it's clear the entry didn't count, and say why.
        await reaction.users.remove(user.id).catch(() => null);
        await user.send({ content: `You couldn't enter the giveaway for **${giveaway.prize.slice(0, 200)}**: ${result.reason}`, allowedMentions: { parse: [] } }).catch(() => null);
        return;
      }
    } else {
      await leaveGiveaway(giveaway, user.id);
    }
    scheduleEntryCountRefresh(message.guild, giveaway.id);
  } catch (error) {
    log.warn(`Failed to handle a reaction entry for giveaway #${giveaway.id}:`, error);
  }
}
