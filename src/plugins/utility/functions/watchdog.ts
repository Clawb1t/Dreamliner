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
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

function tierLabel(t: Translator, tier: WatchdogTier): string {
  const labels: Record<WatchdogTier, string> = {
    critical: t("utility.watchdog.tierCritical", "Critical"),
    elevated: t("utility.watchdog.tierElevated", "Elevated"),
    watch: t("utility.watchdog.tierWatch", "Watch"),
    low: t("utility.watchdog.tierLow", "Low"),
  };
  return labels[tier];
}

/** `/watchdog` — the same risk scoring the dashboard's Watchdog page shows, in Discord. */
export async function buildWatchdogEmbed(
  member: GuildMember,
  guildConfig: GuildConfig,
  client: Client,
  t: Translator = defaultTranslator,
): Promise<ResultContainer> {
  const result = await scoreWatchdogMember(member);

  const embed = setEmbedAuthor(
    baseEmbed(),
    t("utility.watchdog.titleTag", "Watchdog: {tag}", { tag: member.user.tag }),
    client,
    commandHeader(guildConfig, {
      thumbnailURL: member.displayAvatarURL({ size: 128 }),
      emoji: "<:icons_user_mod:1544418270030074030>",
    }),
  ).setColor(memberAccentColor(member));

  embed.addFields(
    embedField(
      t("utility.watchdog.riskAssessmentLabel", "Risk assessment"),
      trimLines(
        t("utility.watchdog.riskAssessmentBody", "Member: <@!{id}>\nScore: **{score}/100**\nTier: **{tier}**", {
          id: member.id,
          score: result.score,
          tier: tierLabel(t, result.tier),
        }),
      ),
    ),
  );

  embed.addFields(
    embedField(
      t("utility.watchdog.accountLabel", "Account"),
      trimLines(
        t(
          "utility.watchdog.accountBody",
          "Created: {created}\nJoined: {joined}\nStrikes: **{strikes}**\nMod cases: **{active}** active (**{total}** total)",
          {
            created: discordTs(member.user.createdAt),
            joined: member.joinedAt ? discordTs(member.joinedAt) : t("utility.watchdog.notAMember", "Not a member"),
            strikes: result.strikes,
            active: result.activeModCases,
            total: result.totalModCases,
          },
        ),
      ),
      true,
    ),
  );

  const reasonLines =
    result.reasons.length > 0
      ? result.reasons.map((reason) => `**+${reason.points}** ${reason.label}`).join("\n")
      : t("utility.watchdog.noRiskSignals", "No risk signals fired for this member.");
  embed.addFields(embedField(t("utility.watchdog.signalsLabel", "Signals"), reasonLines));

  if (result.contentSkipped) {
    embed.addFields(
      embedField(
        t("utility.watchdog.noteLabel", "Note"),
        t(
          "utility.watchdog.contentSkippedBody",
          "Message-content signals were skipped. This member has message-content retention turned off in their profile.",
        ),
      ),
    );
  }

  return embed;
}
