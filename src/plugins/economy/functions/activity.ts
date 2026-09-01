import type { GuildMember, Message } from "discord.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import {
  GLOBAL_MESSAGE_AMOUNT,
  GLOBAL_MESSAGE_COOLDOWN_SECONDS,
  SERVER_MESSAGE_AMOUNT,
  SERVER_MESSAGE_COOLDOWN_SECONDS,
} from "./format.js";
import {
  canClaimGlobalMessage,
  canClaimServerMessage,
  creditGlobal,
  creditServer,
  markGlobalMessageClaimed,
  markServerMessageClaimed,
  round2,
} from "./money.js";

/**
 * Grant message-based earnings for both the global and server economies.
 * Each ledger has its own independent cooldown, so a message can pay out
 * global coins, server currency, both, or neither. Both rates are fixed
 * bot-wide constants — a server can only turn its own reward on/off
 * (`message_rewards_enabled`), not tune the amount or cooldown.
 */
export function grantMessageRewards(member: GuildMember, message: Message, config: EconomyConfig): void {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;
  const userId = member.id;

  if (canClaimGlobalMessage(userId, GLOBAL_MESSAGE_COOLDOWN_SECONDS)) {
    creditGlobal(userId, round2(GLOBAL_MESSAGE_AMOUNT));
    markGlobalMessageClaimed(userId);
  }

  if (config.server.message_rewards_enabled && canClaimServerMessage(guildId, userId, SERVER_MESSAGE_COOLDOWN_SECONDS)) {
    creditServer(guildId, userId, round2(SERVER_MESSAGE_AMOUNT));
    markServerMessageClaimed(guildId, userId);
  }
}
