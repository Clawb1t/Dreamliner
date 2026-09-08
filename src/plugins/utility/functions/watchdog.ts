import type { Client, GuildMember } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { scoreWatchdogMember, type WatchdogTier } from "../../../bridge/watchdogScoring.js";
import {
  baseEmbed,
  commandHeader,
  discordTs,
  embedField,
  memberAccentColor,
  setEmbedAuthor,
  trimLines,
  type ResultContainer,
} from "../../../core/embeds.js";

const TIER_LABEL: Record<WatchdogTier, string> = {
  critical: "Critical",
  elevated: "Elevated",
  watch: "Watch",
  low: "Low",
};

/** `/watchdog` — the same risk scoring the dashboard's Watchdog page shows, in Discord. */
export async function buildWatchdogEmbed(
  member: GuildMember,
  guildConfig: GuildConfig,
  client: Client,
): Promise<ResultContainer> {
  const result = await scoreWatchdogMember(member);

  const embed = setEmbedAuthor(
    baseEmbed(),
    `Watchdog: ${member.user.tag}`,
    client,
    commandHeader(guildConfig, {
      thumbnailURL: member.displayAvatarURL({ size: 128 }),
      emoji: "<:icons_user_mod:1544418270030074030>",
    }),
  ).setColor(memberAccentColor(member));

  embed.addFields(
    embedField(
      "Risk assessment",
      trimLines(`
        Member: <@!${member.id}>
        Score: **${result.score}/100**
        Tier: **${TIER_LABEL[result.tier]}**
      `),
    ),
  );

  embed.addFields(
    embedField(
      "Account",
      trimLines(`
        Created: ${discordTs(member.user.createdAt)}
        Joined: ${member.joinedAt ? discordTs(member.joinedAt) : "Not a member"}
        Strikes: **${result.strikes}**
        Mod cases: **${result.activeModCases}** active (**${result.totalModCases}** total)
      `),
      true,
    ),
  );

  const reasonLines =
    result.reasons.length > 0
      ? result.reasons.map((reason) => `**+${reason.points}** ${reason.label}`).join("\n")
      : "No risk signals fired for this member.";
  embed.addFields(embedField("Signals", reasonLines));

  if (result.contentSkipped) {
    embed.addFields(
      embedField(
        "Note",
        "Message-content signals were skipped. This member has message-content retention turned off in their profile.",
      ),
    );
  }

  return embed;
}
