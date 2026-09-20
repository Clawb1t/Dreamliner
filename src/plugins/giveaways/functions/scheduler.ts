import type { Client, Guild, TextChannel } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { emitLog } from "../../../core/logging/send.js";
import { getLogger } from "../../../core/logger.js";
import { buildClaimComponents, buildGiveawayComponents, buildGiveawayEmbed, buildGiveawayEndedEmbed } from "./embeds.js";
import { drawWinners, expireUnclaimedWinners } from "./draw.js";
import * as store from "./store.js";
import type { Giveaway } from "./store.js";

const log = getLogger("giveaways");

async function fetchSendableChannel(guild: Guild, channelId: string): Promise<TextChannel | null> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  return channel as TextChannel;
}

/** Posts a scheduled/newly-due giveaway's entry message, reacts for reaction-mode entry, and
 *  flips it to "active". Used both by the dashboard's immediate "start now" create path and by
 *  `processDueGiveaways`'s catch-up pass for giveaways whose future `startsAt` has now arrived. */
export async function startGiveaway(guild: Guild, giveaway: Giveaway): Promise<Giveaway | null> {
  const channel = await fetchSendableChannel(guild, giveaway.channelId);
  if (!channel) return null;

  const activeGiveaway: Giveaway = { ...giveaway, status: "active" };
  const embed = buildGiveawayEmbed(activeGiveaway, 0, guild);
  const components = buildGiveawayComponents(activeGiveaway, 0);
  const content = giveaway.pingRoleId ? `<@&${giveaway.pingRoleId}>` : undefined;

  const message = await channel.send({ content, embeds: [embed], components }).catch(() => null);
  if (!message) return null;

  if (giveaway.entryMethod === "reaction") {
    await message.react(giveaway.reactionEmoji).catch(() => {});
  }

  const updated = await store.updateGiveaway(giveaway.id, { messageId: message.id, status: "active" });
  const finalGiveaway = updated ?? { ...activeGiveaway, messageId: message.id };

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  await emitLog(
    guild.client,
    guildConfig,
    {
      title: "Giveaway started",
      information: [
        `**Prize:** ${finalGiveaway.prize}`,
        `**Channel:** <#${finalGiveaway.channelId}>`,
        `**Ends:** <t:${Math.floor(finalGiveaway.endsAt.getTime() / 1000)}:R>`,
      ],
      emojiCategory: "action",
    },
    {
      guildId: guild.id,
      eventType: "giveaway_start",
      summary: `${finalGiveaway.title || finalGiveaway.prize} started in <#${finalGiveaway.channelId}>.`,
      channelId: finalGiveaway.channelId,
      messageId: message.id,
    },
  ).catch(() => null);

  return finalGiveaway;
}

/** Posts every giveaway still "scheduled" whose `startsAt` has arrived. Runs in the same poll
 *  tick as `processDueGiveaways` so a future-dated giveaway created from the dashboard starts on
 *  its own, without needing the dashboard client open at the exact start time. */
export async function processScheduledStarts(client: Client): Promise<void> {
  const due = await store.getGiveawaysDueToStart(new Date());
  for (const giveaway of due) {
    try {
      const guild = await client.guilds.fetch(giveaway.guildId).catch(() => null);
      if (!guild) continue;
      await startGiveaway(guild, giveaway);
    } catch (error) {
      log.error(`Failed to start giveaway #${giveaway.id}:`, error);
    }
  }
}

async function editGiveawayMessage(
  client: Client,
  giveaway: Giveaway,
  winnerUserIds: string[],
  claimComponentsForWinnerRowId: number | null,
): Promise<void> {
  if (!giveaway.messageId) return;
  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) return;

  const embed = buildGiveawayEndedEmbed(giveaway, winnerUserIds);
  const components = claimComponentsForWinnerRowId !== null ? buildClaimComponents(giveaway.id, claimComponentsForWinnerRowId) : [];

  await (channel as TextChannel).messages
    .fetch(giveaway.messageId)
    .then((message) => message.edit({ embeds: [embed], components }))
    .catch((error) => log.warn(`Could not edit giveaway #${giveaway.id}'s message:`, error));
}

async function dmUsers(client: Client, userIds: string[], content: string): Promise<void> {
  for (const userId of userIds) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    await user.send(content).catch(() => null);
  }
}

/** Draws winners, edits the posted message, DMs best-effort, and marks the giveaway ended. Used
 *  by both the poller (`processDueGiveaways`) and the `/giveaway end` command's immediate path. */
export async function finishGiveaway(client: Client, giveaway: Giveaway): Promise<void> {
  const winnerIds = await drawWinners(giveaway);
  const guildConfig = await configManager.getEffectiveConfig(giveaway.guildId);

  const wonWinners = await store.listWinnersByStatus(giveaway.id, "won");
  const claimRowId = giveaway.claimWindowMinutes > 0 && wonWinners[0] ? wonWinners[0].id : null;
  await editGiveawayMessage(client, giveaway, winnerIds, claimRowId);

  if (giveaway.dmWinner && winnerIds.length) {
    await dmUsers(client, winnerIds, `You won **${giveaway.prize}**! Congratulations.`);
  }

  if (giveaway.dmNonWinners) {
    const entries = await store.listEntries(giveaway.id);
    const winnerSet = new Set(winnerIds);
    const nonWinnerIds = entries.map((e) => e.userId).filter((id) => !winnerSet.has(id));
    await dmUsers(client, nonWinnerIds, `The giveaway for **${giveaway.prize}** has ended. You didn't win this time.`);
  }

  await store.updateGiveaway(giveaway.id, { status: "ended", endedAt: new Date() });

  await emitLog(
    client,
    guildConfig,
    {
      title: "Giveaway ended",
      information: [
        `**Prize:** ${giveaway.prize}`,
        `**Channel:** <#${giveaway.channelId}>`,
        winnerIds.length ? `**Winner(s):** ${winnerIds.map((id) => `<@${id}>`).join(", ")}` : "**Winner(s):** No valid entries",
      ],
      emojiCategory: "action",
    },
    {
      guildId: giveaway.guildId,
      eventType: "giveaway_end",
      summary: `${giveaway.title || giveaway.prize} ended with ${winnerIds.length} winner(s).`,
      channelId: giveaway.channelId,
      messageId: giveaway.messageId,
    },
  );
}

export async function processDueGiveaways(client: Client): Promise<void> {
  await processScheduledStarts(client);

  const due = await store.getDueGiveaways(new Date());
  for (const row of due) {
    const claimed = await store.claimGiveawayForEnding(row.id);
    if (!claimed) continue;
    try {
      await finishGiveaway(client, claimed);
    } catch (error) {
      log.error(`Failed to end giveaway #${row.id}:`, error);
    }
  }

  await processExpiredClaimWindows(client);
}

async function processExpiredClaimForGiveaway(client: Client, giveaway: Giveaway): Promise<void> {
  const before = await store.listWinnersByStatus(giveaway.id, "won");
  await expireUnclaimedWinners(giveaway);
  const after = await store.listWinners(giveaway.id);
  const beforeIds = new Set(before.map((w) => w.id));
  const newWinners = after.filter((w) => w.status === "won" && !beforeIds.has(w.id));
  if (!newWinners.length) return;

  const currentWinnerIds = after.filter((w) => w.status === "won" || w.status === "claimed").map((w) => w.userId);
  await editGiveawayMessage(client, giveaway, currentWinnerIds, newWinners[0]!.id);

  if (giveaway.dmWinner) {
    await dmUsers(
      client,
      newWinners.map((w) => w.userId),
      `You're the new winner of **${giveaway.prize}**! The previous winner didn't claim in time. Claim yours before the window closes.`,
    );
  }

  const guildConfig = await configManager.getEffectiveConfig(giveaway.guildId);
  await emitLog(
    client,
    guildConfig,
    {
      title: "Giveaway auto-rerolled",
      information: [
        `**Prize:** ${giveaway.prize}`,
        `**Reason:** Claim window expired`,
        `**New winner(s):** ${newWinners.map((w) => `<@${w.userId}>`).join(", ")}`,
      ],
      emojiCategory: "action",
    },
    {
      guildId: giveaway.guildId,
      eventType: "giveaway_reroll",
      summary: `${giveaway.title || giveaway.prize}: ${newWinners.length} unclaimed winner(s) auto-rerolled.`,
      channelId: giveaway.channelId,
      messageId: giveaway.messageId,
    },
  );
}

export async function processExpiredClaimWindows(client: Client): Promise<void> {
  const candidates = await store.getGiveawaysWithExpiredClaims(new Date());
  for (const giveaway of candidates) {
    try {
      await processExpiredClaimForGiveaway(client, giveaway);
    } catch (error) {
      log.error(`Failed to process expired claim window for giveaway #${giveaway.id}:`, error);
    }
  }
}
