import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type SendableChannels,
} from "discord.js";
import { BIRTHDAY_EMOJI, type BirthdaysConfig, type BirthdayAnnouncement } from "../../../config/schemas/birthdays.js";
import type { WelcomeEventConfig } from "../../../config/schemas/welcome.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { getLogger } from "../../../core/logger.js";
import { renderTemplate } from "../../../core/templates.js";
import { buildDynamicExtras, keysReferencedIn } from "../../../core/templateExtras.js";
import { buildWelcomePayload } from "../../welcome_message/functions/messageBuilder.js";
import { effectiveTimezone, loadActiveBirthdays } from "./config.js";
import {
  ageOn,
  formatBirthday,
  isCelebrationDue,
  localMoment,
  ordinal,
  timeToMinutes,
  type Birthday,
} from "./dates.js";
import {
  birthdaysOnDates,
  celebratedKeys,
  celebrationsToDelete,
  celebrationsWithExpiredRoles,
  claimCelebration,
  countCelebrationsSince,
  isOptedOut,
  updateCelebration,
  type StoredBirthday,
} from "./store.js";

const log = getLogger("birthdays");

export const BIRTHDAY_WISH_CUSTOM_ID = "birthday:wish";
const HOUR_MS = 3_600_000;

// ── Messages ─────────────────────────────────────────────────────────────────

/** Birthday tokens on top of the usual {user}/{guild}/... ones. */
export function birthdayTemplateVars(
  config: BirthdaysConfig,
  birthday: Birthday,
  celebrationYear: number,
  birthdaysToday: number,
): Record<string, string> {
  const age = config.show_age ? ageOn(birthday, celebrationYear) : null;
  return {
    age: age ? String(age) : "",
    age_ordinal: age ? ordinal(age) : "",
    birthday: formatBirthday(birthday),
    birthday_date: formatBirthday(birthday, config.show_age),
    birthdays_today: String(Math.max(1, birthdaysToday)),
  };
}

export function wishButtonLabel(announcement: BirthdayAnnouncement, wishes: number): string {
  const label = announcement.wish_button.label.trim() || "Wish happy birthday";
  return announcement.wish_button.show_count && wishes > 0 ? `${label} · ${wishes}` : label;
}

/** The wish button and link buttons under an announcement, as one row (Discord allows 5 per row). */
export function announcementButtons(
  announcement: BirthdayAnnouncement,
  wishes = 0,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (announcement.wish_button.enabled) {
    const wish = new ButtonBuilder()
      .setCustomId(BIRTHDAY_WISH_CUSTOM_ID)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(wishButtonLabel(announcement, wishes).slice(0, 80));
    const emoji = parseComponentEmoji(announcement.wish_button.emoji || BIRTHDAY_EMOJI);
    if (emoji) wish.setEmoji(emoji);
    buttons.push(wish);
  }
  const usable = announcement.link_buttons.filter((b) => b.label.trim() && /^https?:\/\/\S+$/i.test(b.url.trim()));
  for (const link of usable.slice(0, 5 - buttons.length)) {
    const button = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(link.label.trim().slice(0, 80)).setURL(link.url.trim());
    const emoji = link.emoji ? parseComponentEmoji(link.emoji) : null;
    if (emoji) button.setEmoji(emoji);
    buttons.push(button);
  }
  return buttons.length ? [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons)] : [];
}

type MessageBody = Pick<WelcomeEventConfig, "content" | "embed" | "card">;

async function buildBody(
  body: MessageBody,
  member: GuildMember,
  extraVars: Record<string, string>,
): Promise<MessageCreateOptions | null> {
  const keys = keysReferencedIn(
    body.content,
    body.embed.title,
    body.embed.description,
    body.embed.footer_text,
    ...body.embed.fields.flatMap((f) => [f.name, f.value]),
    body.card.greeting_text,
    body.card.subtitle_text,
  );
  const extra = { ...(await buildDynamicExtras(member, keys)), ...extraVars };
  const built = await buildWelcomePayload(
    { enabled: true, content: body.content, embed: body.embed, card: body.card },
    { guildId: member.guild.id, member, user: member.user, guild: member.guild, extra },
  );
  return built.empty ? null : built.payload;
}

/** The announcement for a member, with its buttons and exactly the pings the server chose. */
export async function buildAnnouncementPayload(
  config: BirthdaysConfig,
  member: GuildMember,
  extraVars: Record<string, string>,
  wishes = 0,
): Promise<MessageCreateOptions | null> {
  const announcement = config.announcement;
  const payload = await buildBody(announcement, member, extraVars);
  const components = announcementButtons(announcement, wishes);
  if (!payload && components.length === 0) return null;
  const rolePings = announcement.ping_roles.map((id) => `<@&${id}>`).join(" ");
  const content = [rolePings, payload?.content ?? ""].filter(Boolean).join(" ");
  return {
    ...(payload ?? {}),
    ...(content ? { content } : {}),
    components,
    allowedMentions: {
      users: announcement.ping_member ? [member.id] : [],
      roles: announcement.ping_roles,
    },
  };
}

export async function buildDmPayload(
  config: BirthdaysConfig,
  member: GuildMember,
  extraVars: Record<string, string>,
): Promise<MessageCreateOptions | null> {
  const payload = await buildBody(config.dm, member, extraVars);
  return payload ? { ...payload, allowedMentions: { parse: [] } } : null;
}

// ── Celebrating ──────────────────────────────────────────────────────────────

function isCelebrated(member: GuildMember, config: BirthdaysConfig): boolean {
  if (member.user.bot) return false;
  if (config.ignored_roles.some((id) => member.roles.cache.has(id))) return false;
  if (config.allowed_roles.length > 0 && !config.allowed_roles.some((id) => member.roles.cache.has(id))) return false;
  return !isOptedOut(member.guild.id, member.id);
}

async function reactAll(message: Message, emojis: string[]): Promise<void> {
  for (const raw of emojis) {
    const parsed = parseComponentEmoji(raw);
    // Unicode emoji come back as the character itself; custom ones as { id, name }.
    const reaction = typeof parsed === "string" ? parsed : (parsed?.id ?? raw.trim());
    if (reaction) await message.react(reaction).catch(() => null);
  }
}

/** Posts the announcement (with reactions and thread), or returns why it couldn't. */
export async function postAnnouncement(
  config: BirthdaysConfig,
  member: GuildMember,
  extraVars: Record<string, string>,
): Promise<{ message: Message | null; detail: string }> {
  const channelId = config.announcement.channel_id?.trim();
  if (!channelId) return { message: null, detail: "No announcement channel is set." };
  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    return { message: null, detail: "The announcement channel is missing or isn't a text channel." };
  }
  const payload = await buildAnnouncementPayload(config, member, extraVars);
  if (!payload) return { message: null, detail: "The announcement has no text, embed, card or buttons." };
  const message = await (channel as SendableChannels).send(payload).catch(() => null);
  if (!message) return { message: null, detail: `Couldn't post in <#${channelId}>. Check my permissions there.` };

  await reactAll(message, config.announcement.reactions);
  const thread = config.announcement.thread;
  if (thread.enabled && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)) {
    const name = renderTemplate(thread.name, { member, guild: member.guild, extra: extraVars }).trim().slice(0, 100);
    await message
      .startThread({ name: name || "Happy birthday!", autoArchiveDuration: thread.auto_archive_minutes })
      .catch(() => null);
  }
  return { message, detail: `Posted in <#${channelId}>.` };
}

async function giveRole(config: BirthdaysConfig, member: GuildMember): Promise<string | null> {
  const roleId = config.role.enabled ? config.role.role_id.trim() : "";
  if (!roleId) return null;
  const role = member.guild.roles.cache.get(roleId);
  const me = member.guild.members.me;
  if (!role || !me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.comparePositionTo(me.roles.highest) >= 0) {
    log.debug(`[birthdays] Can't give role ${roleId} in ${member.guild.id}.`);
    return null;
  }
  const added = await member.roles.add(role, "Birthday").catch(() => null);
  return added ? roleId : null;
}

/** Celebrates one member's birthday in one server, once per year. */
export async function celebrate(
  config: BirthdaysConfig,
  member: GuildMember,
  birthday: StoredBirthday,
  celebrationYear: number,
  now = new Date(),
): Promise<boolean> {
  if (!isCelebrated(member, config)) return false;
  if (!claimCelebration(member.guild.id, member.id, celebrationYear, now)) return false;

  // Includes this celebration, which was just claimed.
  const birthdaysToday = countCelebrationsSince(member.guild.id, new Date(now.getTime() - 24 * HOUR_MS));
  const extraVars = birthdayTemplateVars(config, birthday, celebrationYear, birthdaysToday);

  const roleId = await giveRole(config, member);
  if (roleId) {
    updateCelebration(member.guild.id, member.id, celebrationYear, {
      roleId,
      roleExpiresAt: new Date(now.getTime() + config.role.duration_hours * HOUR_MS),
    });
  }

  if (config.announcement.enabled) {
    const { message } = await postAnnouncement(config, member, extraVars);
    if (message) {
      updateCelebration(member.guild.id, member.id, celebrationYear, {
        channelId: message.channelId,
        messageId: message.id,
        deleteAt:
          config.announcement.delete_after_hours > 0
            ? new Date(now.getTime() + config.announcement.delete_after_hours * HOUR_MS)
            : null,
      });
    }
  }

  if (config.dm.enabled) {
    const dm = await buildDmPayload(config, member, extraVars);
    if (dm) await member.send(dm).catch(() => null);
  }
  return true;
}

// ── The minute tick ──────────────────────────────────────────────────────────

/** The month/days that could be "today" somewhere (UTC-12 to UTC+14), plus 29 Feb near it. */
function candidateDates(now: Date): Array<{ month: number; day: number }> {
  const dates = new Map<string, { month: number; day: number }>();
  for (const offset of [-1, 0, 1]) {
    const d = new Date(now.getTime() + offset * 24 * HOUR_MS);
    dates.set(`${d.getUTCMonth() + 1}-${d.getUTCDate()}`, { month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  if (dates.has("2-28") || dates.has("3-1")) dates.set("2-29", { month: 2, day: 29 });
  return [...dates.values()];
}

async function cleanup(client: Client, now: Date): Promise<void> {
  for (const row of celebrationsWithExpiredRoles(now)) {
    const guild = client.guilds.cache.get(row.guildId);
    const member = guild ? await guild.members.fetch(row.userId).catch(() => null) : null;
    if (member && row.roleId) await member.roles.remove(row.roleId, "Birthday over").catch(() => null);
    updateCelebration(row.guildId, row.userId, row.year, { roleRemovedAt: now });
  }
  for (const row of celebrationsToDelete(now)) {
    const guild = client.guilds.cache.get(row.guildId);
    const channel = guild && row.channelId ? await guild.channels.fetch(row.channelId).catch(() => null) : null;
    if (channel?.isTextBased() && row.messageId) {
      const message = await channel.messages.fetch(row.messageId).catch(() => null);
      await message?.delete().catch(() => null);
    }
    updateCelebration(row.guildId, row.userId, row.year, { deletedAt: now });
  }
}

async function celebrateDueIn(guild: Guild, config: BirthdaysConfig, candidates: StoredBirthday[], now: Date) {
  const celebrateAt = timeToMinutes(config.celebrate_time);
  const due: Array<{ birthday: StoredBirthday; year: number }> = [];
  for (const birthday of candidates) {
    const local = localMoment(now, effectiveTimezone(config, birthday.timezone));
    if (isCelebrationDue(birthday, local, celebrateAt, config.leap_day)) due.push({ birthday, year: local.year });
  }
  if (due.length === 0) return;

  const done = celebratedKeys(
    guild.id,
    due.map((d) => d.birthday.userId),
  );
  const pending = due.filter((d) => !done.has(`${d.birthday.userId}:${d.year}`));
  if (pending.length === 0) return;

  // Only now ask Discord who's actually in the server (once per member per birthday).
  const missing = pending.map((d) => d.birthday.userId).filter((id) => !guild.members.cache.has(id));
  if (missing.length > 0) await guild.members.fetch({ user: missing }).catch(() => null);
  for (const { birthday, year } of pending) {
    const member = guild.members.cache.get(birthday.userId);
    if (member) await celebrate(config, member, birthday, year, now).catch((e) => log.warn("[birthdays] celebrate failed:", e));
  }
}

/** Runs every minute: celebrates birthdays that have started, removes expired roles and deletes
 *  announcements past their time. */
export async function tickBirthdays(client: Client, now = new Date()): Promise<void> {
  await cleanup(client, now);
  const candidates = birthdaysOnDates(candidateDates(now));
  if (candidates.length === 0) return;
  for (const guild of client.guilds.cache.values()) {
    const config = await loadActiveBirthdays(guild.id);
    if (config) await celebrateDueIn(guild, config, candidates, now);
  }
}
