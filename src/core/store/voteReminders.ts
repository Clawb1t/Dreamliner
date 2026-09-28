import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type MessageCreateOptions,
} from "discord.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { storeVotes, voteReminderPrefs } from "../../db/schema.js";
import { DREAMLINER_ACCENT } from "../embeds.js";
import { VOTE_URL, getAccountStoreUrl } from "../docsUrl.js";
import { getLogger } from "../logger.js";
import { defaultTranslator, translatorFor, type Translator } from "../../i18n/index.js";
import { getCreditBalance } from "./credits.js";
import { STORE_PRICING } from "./pricing.js";

/**
 * "You can vote again" DMs: 12 hours after a member's latest vote (top.gg's cooldown), Dreamliner
 * DMs them a reminder with a vote button and a button to stop reminders. On by default; members
 * turn it off from the DM itself or from Account → Store.
 */

const log = getLogger("store");

export const VOTE_REMINDER_PREFIX = "dl:votereminder:";
const OFF_ID = `${VOTE_REMINDER_PREFIX}off`;
const ON_ID = `${VOTE_REMINDER_PREFIX}on`;

const VOTE_COOLDOWN_MS = 12 * 60 * 60_000;
/** Reminders that came due while the bot was down still go out if they're at most this late. */
const LATE_WINDOW_MS = 2 * 60 * 60_000;
const BATCH_SIZE = 50;

const LOGO = "<:dreamlinerlogo:1536010087468892161>";
const UPVOTE = "<:icons_upvote:1544417455689179349>";
const NOTIFY = { id: "1544417566708211753", name: "icons_notify" };

export function voteRemindersEnabled(userId: string): boolean {
  const row = getDb().select().from(voteReminderPrefs).where(eq(voteReminderPrefs.userId, userId)).get();
  return row?.enabled ?? true;
}

export function setVoteReminders(userId: string, enabled: boolean): void {
  const updatedAt = new Date();
  getDb()
    .insert(voteReminderPrefs)
    .values({ userId, enabled, updatedAt })
    .onConflictDoUpdate({ target: voteReminderPrefs.userId, set: { enabled, updatedAt } })
    .run();
}

function container(content: string, buttons: Array<Record<string, unknown>>): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        accentColor: DREAMLINER_ACCENT,
        components: [
          { type: ComponentType.TextDisplay, content },
          { type: ComponentType.ActionRow, components: buttons },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  } as MessageCreateOptions;
}

function voteButton(t: Translator) {
  return {
    type: ComponentType.Button,
    style: ButtonStyle.Link,
    label: t("store.reminder.voteButton", "Vote for Dreamliner"),
    url: VOTE_URL,
  };
}

/** The reminder DM itself. */
export function buildVoteReminder(balance: number, t: Translator = defaultTranslator): MessageCreateOptions {
  const lines = [
    `${LOGO} **${t("store.reminder.title", "You can vote again")}**`,
    t(
      "store.reminder.body",
      "It's been 12 hours since your last vote for Dreamliner. Vote again to earn **{credits} store credits** to spend on Dreamliner One for a server you manage.",
      { credits: STORE_PRICING.creditsPerVote },
    ),
    `-# ${UPVOTE} ${t("store.reminder.balance", "You have {balance} credits. [Open the store]({url})", {
      balance: balance.toLocaleString(),
      url: getAccountStoreUrl(),
    })}`,
  ];
  return container(lines.join("\n"), [
    voteButton(t),
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: t("store.reminder.stopButton", "Stop reminders"),
      emoji: NOTIFY,
      custom_id: OFF_ID,
    },
  ]);
}

function buildRemindersOff(t: Translator): MessageCreateOptions {
  return container(
    `${LOGO} **${t("store.reminder.offTitle", "Vote reminders are off")}**\n${t(
      "store.reminder.offBody",
      "You won't get these DMs anymore. Turn them back on here, or from the Store on your Dreamliner account page.",
    )}`,
    [
      voteButton(t),
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: t("store.reminder.onButton", "Turn reminders back on"),
        emoji: NOTIFY,
        custom_id: ON_ID,
      },
    ],
  );
}

function buildRemindersOn(t: Translator): MessageCreateOptions {
  return container(
    `${LOGO} **${t("store.reminder.onTitle", "Vote reminders are on")}**\n${t(
      "store.reminder.onBody",
      "Dreamliner will DM you 12 hours after each vote, when you can vote again.",
    )}`,
    [
      voteButton(t),
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: t("store.reminder.stopButton", "Stop reminders"),
        emoji: NOTIFY,
        custom_id: OFF_ID,
      },
    ],
  );
}

/** "Stop reminders" / "Turn reminders back on" on the DM. Always acts on the member who pressed it. */
export async function handleVoteReminderButton(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId !== OFF_ID && interaction.customId !== ON_ID) return false;
  const enabled = interaction.customId === ON_ID;
  setVoteReminders(interaction.user.id, enabled);
  const { t } = await translatorFor(interaction.user.id);
  const payload = enabled ? buildRemindersOn(t) : buildRemindersOff(t);
  await interaction.update({ components: payload.components, flags: MessageFlags.IsComponentsV2 });
  return true;
}

type DueVote = { id: number; userId: string };

/** Each member's latest vote that reached its 12 hours recently and hasn't been reminded yet. */
function dueReminders(now: number): DueVote[] {
  const dueBefore = new Date(now - VOTE_COOLDOWN_MS);
  const windowStart = new Date(now - VOTE_COOLDOWN_MS - LATE_WINDOW_MS);
  return getDb()
    .select({ id: storeVotes.id, userId: storeVotes.userId })
    .from(storeVotes)
    .where(
      and(
        isNull(storeVotes.reminderSentAt),
        sql`${storeVotes.votedAt} <= ${dueBefore.getTime()}`,
        sql`${storeVotes.votedAt} > ${windowStart.getTime()}`,
        // Only the member's latest vote: a newer one gets its own reminder later.
        sql`not exists (select 1 from store_votes newer where newer.user_id = ${storeVotes.userId} and newer.voted_at > ${storeVotes.votedAt})`,
      ),
    )
    .limit(BATCH_SIZE)
    .all();
}

/** Sends every reminder that's due. Runs every minute. */
export async function sendDueVoteReminders(client: Client, now = Date.now()): Promise<number> {
  let sent = 0;
  for (const vote of dueReminders(now)) {
    // Marked first, so a reminder is never sent twice even if the DM fails (DMs closed, etc.).
    getDb().update(storeVotes).set({ reminderSentAt: new Date(now) }).where(eq(storeVotes.id, vote.id)).run();
    if (!voteRemindersEnabled(vote.userId)) continue;
    try {
      const user = await client.users.fetch(vote.userId);
      const { t } = await translatorFor(vote.userId);
      await user.send(buildVoteReminder(getCreditBalance(vote.userId), t));
      sent++;
    } catch (error) {
      log.debug(`[store] Vote reminder DM to ${vote.userId} failed:`, error);
    }
  }
  return sent;
}
