import type { GuildMember, Message } from "discord.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import {
  GLOBAL_MESSAGE_AMOUNT,
  GLOBAL_MESSAGE_COOLDOWN_SECONDS,
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
 * global coins, server currency, both, or neither.
 */
export function grantMessageRewards(member: GuildMember, message: Message, config: EconomyConfig): void {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;
  const userId = member.id;

  if (canClaimGlobalMessage(userId, GLOBAL_MESSAGE_COOLDOWN_SECONDS)) {
    creditGlobal(userId, round2(GLOBAL_MESSAGE_AMOUNT));
    markGlobalMessageClaimed(userId);
  }

  const server = config.server;
  if (
    server.message_rewards_enabled &&
    server.message_amount > 0 &&
    canClaimServerMessage(guildId, userId, server.message_cooldown_seconds)
  ) {
    creditServer(guildId, userId, round2(server.message_amount * server.multiplier));
    markServerMessageClaimed(guildId, userId);
  }
}
