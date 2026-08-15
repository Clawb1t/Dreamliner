import type { Client, GuildMember } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { PassportConfig } from "../../../config/schemas/passport.js";
import { emitLog } from "../../../core/logging/send.js";
import { accountAgeTooYoung, applyVerifiedRewards, type PassportRewards } from "./roles.js";
import { deletePassportMessage } from "./delivery.js";
import { deletePassportPending, getPassportPending, upsertPassportVerification } from "./store.js";

export type PassportCompleteResult =
  | { ok: true; alreadyVerified?: boolean; rewards: PassportRewards }
  | { ok: false; code: string; error: string };

export async function completePassportVerification(options: {
  client: Client;
  member: GuildMember;
  guildConfig: GuildConfig;
  config: PassportConfig;
  method: "web" | "force";
  alreadyVerified: boolean;
}): Promise<PassportCompleteResult> {
  const { client, member, guildConfig, config, method, alreadyVerified } = options;

  if (method === "web" && accountAgeTooYoung(member.user.createdTimestamp, config.min_account_age_seconds)) {
    return {
      ok: false,
      code: "account_age",
      error: "This Discord account is too new to verify here.",
    };
  }

  const rewards = await applyVerifiedRewards(member, config);
  await upsertPassportVerification({
    guildId: member.guild.id,
    userId: member.id,
    method,
    accountCreatedAt: member.user.createdAt,
  });

  // Optional one-time economy bonus when Economy is enabled.
  try {
    const { loadEconomyConfig } = await import("../../economy/functions/config.js");
    const { grantStartingBalance, getPrimaryCurrencyKey, mutateMoney, ensureGuildCurrencies } = await import(
      "../../economy/functions/money.js"
    );
    const eco = await loadEconomyConfig(member.guild.id);
    if (eco && !alreadyVerified && eco.starting_balance >= 0) {
      ensureGuildCurrencies(member.guild.id, eco);
      grantStartingBalance(member.guild.id, member.id, eco);
      const bonus = Math.max(0, Math.floor(eco.rewards.daily_amount / 2));
      if (bonus > 0) {
        mutateMoney(
          {
            guildId: member.guild.id,
            userId: member.id,
            currencyKey: getPrimaryCurrencyKey(member.guild.id, eco),
            deltaPocket: bonus,
            reason: "passport_verify",
            idempotencyKey: `passport:${member.guild.id}:${member.id}`,
          },
          { config: eco, skipPauseCheck: true },
        );
      }
    }
  } catch {
    /* economy optional */
  }

  const pending = await getPassportPending(member.guild.id, member.id);
  if (pending && config.ping.delete_on_verify) {
    await deletePassportMessage(member.guild, pending.pingChannelId, pending.pingMessageId);
  }
  await deletePassportPending(member.guild.id, member.id);

  await emitLog(
    client,
    guildConfig,
    {
      title: alreadyVerified ? "Passport re-verified" : "Passport verified",
      avatarUrl: member.user.displayAvatarURL({ size: 64 }),
      information: [
        `**Member:** ${member} \`${member.id}\``,
        `**Method:** ${method === "force" ? "staff force" : "website"}`,
      ],
    },
    {
      guildId: member.guild.id,
      eventType: "passport_verify",
      summary: `${member.user.tag} verified with Passport.`,
      actorId: member.id,
      targetId: member.id,
    },
  );

  return { ok: true, alreadyVerified, rewards };
}
