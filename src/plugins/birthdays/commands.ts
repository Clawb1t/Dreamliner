import { SlashCommandBuilder, type SlashCommandSubcommandBuilder, type User } from "discord.js";
import {
  BIRTHDAY_DATE_EMOJI,
  BIRTHDAY_EMOJI,
  BIRTHDAY_TADA_EMOJI,
  type BirthdaysConfig,
} from "../../config/schemas/birthdays.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import { resolveTimezoneInput } from "../utility/functions/time.js";
import { PLUGIN, effectiveTimezone, loadBirthdaysConfig } from "./functions/config.js";
import {
  ageOn,
  daysUntilBirthday,
  formatBirthday,
  isValidBirthday,
  localMoment,
  MONTH_NAMES,
  nextCelebrationAt,
  timeToMinutes,
  type Birthday,
} from "./functions/dates.js";
import { getBirthday, getBirthdays, isOptedOut, removeBirthday, setBirthday, setOptedOut } from "./functions/store.js";

const MONTH_CHOICES = MONTH_NAMES.map((name, i) => ({ name, value: i + 1 }));
const MAX_UPCOMING = 10;

type Tone = "neutral" | "success" | "warning" | "error";

async function reply(ctx: SlashCommandContext, title: string, body: string, tone: Tone = "neutral", ephemeral = ctx.ephemeral) {
  await ctx.interaction.reply(resultReply(title, body, ephemeral, slashResultOptions(ctx, { tone, emoji: BIRTHDAY_EMOJI })));
}

/** "today", or a Discord relative timestamp (e.g. "in 8 months") to when it's next celebrated. */
function whenLabel(ctx: SlashCommandContext, config: BirthdaysConfig, birthday: Birthday, memberTimezone: string | null): string {
  const timezone = effectiveTimezone(config, memberTimezone);
  const now = new Date();
  if (daysUntilBirthday(birthday, localMoment(now, timezone), config.leap_day) === 0) {
    return ctx.t("birthdays.today", "today {emoji}", { emoji: BIRTHDAY_TADA_EMOJI });
  }
  const at = nextCelebrationAt(birthday, now, timezone, timeToMinutes(config.celebrate_time), config.leap_day);
  return `<t:${Math.floor(at.getTime() / 1000)}:R>`;
}

/** "14 March, turning 27, in 4 days" for a birthday, from the server's point of view. */
function describe(ctx: SlashCommandContext, config: BirthdaysConfig, birthday: Birthday, memberTimezone: string | null): string {
  const today = localMoment(new Date(), config.timezone);
  const days = daysUntilBirthday(birthday, today, config.leap_day);
  const nextYear = days === 0 || birthday.month > today.month || (birthday.month === today.month && birthday.day >= today.day)
    ? today.year
    : today.year + 1;
  const age = config.show_age ? ageOn(birthday, nextYear) : null;
  const parts = [`**${formatBirthday(birthday)}**`];
  if (age) parts.push(ctx.t("birthdays.turning", "turning {age}", { age }));
  parts.push(whenLabel(ctx, config, birthday, memberTimezone));
  return parts.join(" · ");
}

/** Reads month/day/year (and timezone) options into a birthday, or explains what's wrong. */
function readBirthdayOptions(
  ctx: SlashCommandContext,
  config: BirthdaysConfig,
): { birthday: Birthday; timezone: string | null } | { error: string } {
  const { options } = ctx.interaction;
  const month = options.getInteger("month", true);
  const day = options.getInteger("day", true);
  const year = options.getInteger("year");
  const timezoneRaw = options.getString("timezone")?.trim() || null;

  if (config.require_year && year === null) {
    return { error: ctx.t("birthdays.yearRequired", "This server asks for your birth year too. Add the `year` option.") };
  }
  const thisYear = new Date().getUTCFullYear();
  if (year !== null && (year < thisYear - 120 || year > thisYear - 5)) {
    return { error: ctx.t("birthdays.badYear", "That birth year doesn't look right.") };
  }
  if (!isValidBirthday(month, day, year)) {
    return {
      error: ctx.t("birthdays.badDate", "{month} doesn't have a day {day}.", { month: MONTH_NAMES[month - 1]!, day }),
    };
  }
  let timezone: string | null = null;
  if (timezoneRaw) {
    const resolved = resolveTimezoneInput(timezoneRaw);
    if (!resolved) {
      return {
        error: ctx.t(
          "birthdays.badTimezone",
          "I don't recognise that timezone. Try one like `Europe/London`, `America/New_York` or `GMT+2`.",
        ),
      };
    }
    timezone = resolved.iana ?? timezoneRaw;
  }
  return { birthday: { month, day, year }, timezone };
}

function addDateOptions(builder: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return builder
    .addIntegerOption((o) =>
      o.setName("month").setDescription("Month you were born").setRequired(true).addChoices(...MONTH_CHOICES),
    )
    .addIntegerOption((o) => o.setName("day").setDescription("Day of the month").setRequired(true).setMinValue(1).setMaxValue(31))
    .addIntegerOption((o) =>
      o.setName("year").setDescription("Birth year (optional, only used to show ages)").setMinValue(1900).setMaxValue(2100),
    );
}

async function upcomingFor(guild: import("discord.js").Guild, config: BirthdaysConfig) {
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const humans = [...members.values()].filter((m) => !m.user.bot);
  const birthdays = getBirthdays(humans.map((m) => m.id));
  const today = localMoment(new Date(), config.timezone);
  return humans
    .filter((m) => birthdays.has(m.id))
    .map((m) => ({ member: m, birthday: birthdays.get(m.id)!, days: daysUntilBirthday(birthdays.get(m.id)!, today, config.leap_day) }))
    .sort((a, b) => a.days - b.days || a.member.displayName.localeCompare(b.member.displayName));
}

export const birthdaysCommands: SlashCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data: new SlashCommandBuilder()
      .setName("birthday")
      .setDescription("Set your birthday and see who's celebrating soon")
      .addSubcommand((sub) =>
        addDateOptions(sub.setName("set").setDescription("Set your birthday")).addStringOption((o) =>
          o
            .setName("timezone")
            .setDescription("Your timezone, e.g. Europe/London or GMT+2 (optional)")
            .setMaxLength(64),
        ),
      )
      .addSubcommand((sub) => sub.setName("remove").setDescription("Remove your birthday"))
      .addSubcommand((sub) =>
        sub
          .setName("view")
          .setDescription("See someone's birthday")
          .addUserOption((o) => o.setName("user").setDescription("Whose birthday (defaults to you)")),
      )
      .addSubcommand((sub) => sub.setName("upcoming").setDescription("See the next birthdays in this server"))
      .addSubcommand((sub) =>
        sub
          .setName("privacy")
          .setDescription("Choose whether this server celebrates your birthday")
          .addBooleanOption((o) => o.setName("celebrate").setDescription("Celebrate my birthday here").setRequired(true)),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("manage")
          .setDescription("Set or remove someone else's birthday (staff)")
          .addSubcommand((sub) =>
            addDateOptions(
              sub
                .setName("set")
                .setDescription("Set a member's birthday")
                .addUserOption((o) => o.setName("user").setDescription("The member").setRequired(true)),
            ),
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Remove a member's birthday")
              .addUserOption((o) => o.setName("user").setDescription("The member").setRequired(true)),
          ),
      ),
    execute: async (ctx) => {
      const { t } = ctx;
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const title = t("birthdays.title", "Birthdays");

      if (group === "manage") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        const config = loadBirthdaysConfig(ctx.guildConfig);
        const target = ctx.interaction.options.getUser("user", true);
        if (target.bot) {
          await reply(ctx, title, t("birthdays.noBots", "Bots don't have birthdays."), "warning");
          return;
        }
        if (sub === "remove") {
          const removed = removeBirthday(target.id);
          await reply(
            ctx,
            title,
            removed
              ? t("birthdays.manageRemoved", "Removed <@{user}>'s birthday.", { user: target.id })
              : t("birthdays.manageNone", "<@{user}> hasn't set a birthday.", { user: target.id }),
            removed ? "success" : "neutral",
          );
          return;
        }
        const read = readBirthdayOptions(ctx, { ...config, require_year: false });
        if ("error" in read) {
          await reply(ctx, title, read.error, "error", true);
          return;
        }
        const previous = getBirthday(target.id);
        setBirthday(target.id, read.birthday, previous?.timezone ?? null);
        await reply(
          ctx,
          title,
          t("birthdays.manageSet", "Set <@{user}>'s birthday to {when}.", {
            user: target.id,
            when: describe(ctx, config, read.birthday, previous?.timezone ?? null),
          }),
          "success",
        );
        return;
      }

      if (sub === "set" || sub === "remove") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_set");
        if (!auth) return;
        const config = loadBirthdaysConfig(ctx.guildConfig);
        if (sub === "remove") {
          const removed = removeBirthday(ctx.interaction.user.id);
          await reply(
            ctx,
            title,
            removed
              ? t("birthdays.removed", "Your birthday is removed. It won't be celebrated anywhere now.")
              : t("birthdays.noneSet", "You haven't set a birthday yet. Use `/birthday set`."),
            removed ? "success" : "neutral",
            true,
          );
          return;
        }
        const read = readBirthdayOptions(ctx, config);
        if ("error" in read) {
          await reply(ctx, title, read.error, "error", true);
          return;
        }
        const previous = getBirthday(ctx.interaction.user.id);
        setBirthday(ctx.interaction.user.id, read.birthday, read.timezone ?? previous?.timezone ?? null);
        const savedTimezone = read.timezone ?? previous?.timezone ?? null;
        const lines = [
          t("birthdays.saved", "Saved! Your birthday is {when}.", { when: describe(ctx, config, read.birthday, savedTimezone) }),
        ];
        if (config.timezone_mode === "member") {
          const tz = read.timezone ?? previous?.timezone ?? null;
          lines.push(
            tz
              ? t("birthdays.savedTimezone", "It starts at {time} in your timezone ({tz}).", { time: config.celebrate_time, tz })
              : t("birthdays.savedNoTimezone", "Add the `timezone` option so it starts at the right time for you."),
          );
        }
        if (isOptedOut(ctx.interaction.guildId!, ctx.interaction.user.id)) {
          lines.push(t("birthdays.savedOptedOut", "You've turned celebrations off in this server. Use `/birthday privacy` to turn them back on."));
        }
        await reply(ctx, title, lines.join("\n"), "success", true);
        return;
      }

      const auth = sub === "privacy"
        ? await requirePluginPermission(ctx, PLUGIN, "can_set")
        : await requirePluginPermission(ctx, PLUGIN, "can_view");
      if (!auth) return;
      const config = loadBirthdaysConfig(ctx.guildConfig);

      if (sub === "privacy") {
        const celebrateHere = ctx.interaction.options.getBoolean("celebrate", true);
        setOptedOut(ctx.interaction.guildId!, ctx.interaction.user.id, !celebrateHere);
        await reply(
          ctx,
          title,
          celebrateHere
            ? t("birthdays.privacyOn", "This server will celebrate your birthday.")
            : t("birthdays.privacyOff", "This server won't celebrate your birthday. Other servers still can."),
          "success",
          true,
        );
        return;
      }

      if (sub === "view") {
        const user: User = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
        const birthday = getBirthday(user.id);
        const self = user.id === ctx.interaction.user.id;
        await reply(
          ctx,
          title,
          birthday
            ? t("birthdays.viewSet", "<@{user}>'s birthday: {when}", {
                user: user.id,
                when: describe(ctx, config, birthday, birthday.timezone),
              })
            : self
              ? t("birthdays.noneSet", "You haven't set a birthday yet. Use `/birthday set`.")
              : t("birthdays.viewNone", "<@{user}> hasn't set a birthday.", { user: user.id }),
        );
        return;
      }

      // upcoming
      const guild = ctx.interaction.guild!;
      const list = (await upcomingFor(guild, config)).slice(0, MAX_UPCOMING);
      await reply(
        ctx,
        t("birthdays.upcomingTitle", "Upcoming birthdays"),
        list.length
          ? list
              .map(({ member, birthday, days }) =>
                `${days === 0 ? BIRTHDAY_EMOJI : BIRTHDAY_DATE_EMOJI} <@${member.id}> · ${formatBirthday(birthday)} · ${whenLabel(ctx, config, birthday, birthday.timezone)}`,
              )
              .join("\n")
          : t("birthdays.upcomingNone", "Nobody here has set a birthday yet. Members can add theirs with `/birthday set`."),
      );
    },
  },
];

export { upcomingFor };
