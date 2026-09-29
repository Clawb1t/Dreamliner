import type { Client, Guild, GuildMember } from "discord.js";
import { zBirthdaysConfig, type BirthdaysConfig } from "../config/schemas/birthdays.js";
import { configManager } from "../config/manager.js";
import { upcomingFor } from "../plugins/birthdays/commands.js";
import { loadBirthdaysConfig } from "../plugins/birthdays/functions/config.js";
import {
  birthdayTemplateVars,
  buildDmPayload,
  postAnnouncement,
} from "../plugins/birthdays/functions/celebrate.js";
import { ageOn, formatBirthday, localMoment, type Birthday } from "../plugins/birthdays/functions/dates.js";
import { getBirthday, optedOutIn } from "../plugins/birthdays/functions/store.js";
import { buildWelcomePreview } from "./webWelcome.js";

export type BirthdayTarget = "announcement" | "dm";

/** The draft config the dashboard sent (so previews and tests show unsaved edits), else the saved one. */
async function resolveConfig(guildId: string, draft: unknown): Promise<BirthdaysConfig> {
  if (draft != null) {
    const parsed = zBirthdaysConfig.safeParse(draft);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid Birthdays config.");
    return parsed.data;
  }
  return loadBirthdaysConfig(await configManager.getEffectiveConfig(guildId));
}

/** Previews and tests use the staff member's own birthday when they've set one, else a sample
 *  that turns 21 today, so every token has something to show. */
function sampleBirthday(userId: string, config: BirthdaysConfig): { birthday: Birthday; year: number } {
  const today = localMoment(new Date(), config.timezone);
  const own = getBirthday(userId);
  if (own) return { birthday: own, year: today.year };
  return { birthday: { month: today.month, day: today.day, year: today.year - 21 }, year: today.year };
}

function readTarget(value: unknown): BirthdayTarget {
  return value === "dm" ? "dm" : "announcement";
}

export async function previewBirthdayMessage(
  client: Client,
  guild: Guild,
  userId: string,
  body: { config?: unknown; target?: unknown },
) {
  const config = await resolveConfig(guild.id, body.config);
  const message = readTarget(body.target) === "dm" ? config.dm : config.announcement;
  const { birthday, year } = sampleBirthday(userId, config);
  return buildWelcomePreview(client, guild, {
    content: message.content,
    embed: message.embed,
    card: message.card,
    sampleUserId: userId,
    extra: birthdayTemplateVars(config, birthday, year, 1),
  });
}

/** Sends the announcement (to its channel) or DM (to the staff member) as if it were their
 *  birthday today. Nothing is recorded and no role is given. */
export async function sendBirthdayTest(
  guild: Guild,
  member: GuildMember,
  body: { config?: unknown; target?: unknown },
): Promise<{ ok: boolean; detail: string }> {
  let config: BirthdaysConfig;
  try {
    config = await resolveConfig(guild.id, body.config);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Invalid config." };
  }
  const { birthday, year } = sampleBirthday(member.id, config);
  const extra = birthdayTemplateVars(config, birthday, year, 1);

  if (readTarget(body.target) === "dm") {
    const payload = await buildDmPayload(config, member, extra);
    if (!payload) return { ok: false, detail: "The DM has no text, embed or card." };
    const sent = await member.send(payload).catch(() => null);
    return sent ? { ok: true, detail: "Sent to your DMs." } : { ok: false, detail: "Couldn't DM you. Check your privacy settings." };
  }
  const { message, detail } = await postAnnouncement(config, member, extra);
  return { ok: Boolean(message), detail };
}

export type BirthdayOverviewEntry = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  birthday: string;
  age: number | null;
  daysUntil: number;
};

/** Upcoming birthdays for the dashboard: who's next, and how many members have set one. */
export async function getBirthdayOverview(guild: Guild): Promise<{
  membersWithBirthdays: number;
  optedOut: number;
  upcoming: BirthdayOverviewEntry[];
}> {
  const config = loadBirthdaysConfig(await configManager.getEffectiveConfig(guild.id));
  const all = await upcomingFor(guild, config);
  const optouts = optedOutIn(guild.id);
  const today = localMoment(new Date(), config.timezone);
  return {
    membersWithBirthdays: all.length,
    optedOut: all.filter((entry) => optouts.has(entry.member.id)).length,
    upcoming: all
      .filter((entry) => !optouts.has(entry.member.id))
      .slice(0, 12)
      .map(({ member, birthday, days }) => ({
        userId: member.id,
        name: member.displayName,
        avatarUrl: member.displayAvatarURL({ size: 64, extension: "png" }),
        birthday: formatBirthday(birthday),
        // The age they turn on this coming birthday.
        age: config.show_age ? ageOn(birthday, today.year + (days > 0 && isEarlierInYear(birthday, today) ? 1 : 0)) : null,
        daysUntil: days,
      })),
  };
}

function isEarlierInYear(birthday: Birthday, today: { month: number; day: number }): boolean {
  return birthday.month < today.month || (birthday.month === today.month && birthday.day < today.day);
}
