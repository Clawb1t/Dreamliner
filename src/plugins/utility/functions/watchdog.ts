import { EmbedBuilder, type Client, type GuildMember } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { scoreWatchdogMember, type WatchdogTier } from "../../../bridge/watchdogScoring.js";
import {
  baseEmbed,
  commandHeader,
  discordTs,
  embedField,
  setEmbedAuthor,
  trimLines,
} from "../../../core/embeds.js";

// Same tier colors as the dashboard's Watchdog page (globals.css --wd-danger/
// --wd-warn/--wd-watch, plus the shared success green) so the two stay
// visually consistent.
const TIER_COLOR: Record<WatchdogTier, number> = {
  critical: 0xda3e44,
  elevated: 0xea580c,
  watch: 0xffc04e,
  low: 0x12c46a,
};

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
): Promise<EmbedBuilder> {
  const result = await scoreWatchdogMember(member);

  const embed = setEmbedAuthor(
    baseEmbed(),
    `Watchdog: ${member.user.tag}`,
    client,
    commandHeader(guildConfig, {
      thumbnailURL: member.displayAvatarURL({ size: 128 }),
      emoji: "<:icons_user_mod:1544418270030074030>",
    }),
  );
  embed.setColor(TIER_COLOR[result.tier]);

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
