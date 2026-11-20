/**
 * Quiz panels: the public card with the Start button. Posted from /quiz post or the dashboard,
 * and refreshed when the quiz changes (published, closed, edited, opened on schedule).
 */
import type { Guild } from "discord.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { panelPayload } from "./render.js";
import { quizIsOpen } from "./rules.js";
import * as store from "./store.js";
import type { Quiz } from "./types.js";

const log = getLogger("quizzes");

function players(quiz: Quiz): number {
  return store.attemptAggregates(quiz.guildId, new Date(0)).get(quiz.id)?.players ?? 0;
}

export function panelUrl(quiz: Pick<Quiz, "guildId" | "panelChannelId" | "panelMessageId">): string | null {
  return quiz.panelChannelId && quiz.panelMessageId ? `https://discord.com/channels/${quiz.guildId}/${quiz.panelChannelId}/${quiz.panelMessageId}` : null;
}

export async function postPanel(guild: Guild, quiz: Quiz, channelId: string, actorId: string): Promise<{ url: string; quiz: Quiz } | { error: string }> {
  if (quiz.status !== "published") return { error: "Publish the quiz before posting its panel." };
  const questionCount = store.listQuestions(quiz.id).length;
  if (!questionCount) return { error: "Add some questions first." };
  const channel = await fetchGuildTextChannel(guild.client, guild.id, channelId);
  if (!channel) return { error: "That channel isn't in this server, or Dreamliner can't post there." };
  try {
    const message = await channel.send(panelPayload(quiz, questionCount, { players: players(quiz) }, quizIsOpen(quiz, Date.now())));
    // One panel per quiz: posting again moves it, so the old one goes.
    if (quiz.panelChannelId && quiz.panelMessageId && quiz.panelMessageId !== message.id) {
      const old = await fetchGuildTextChannel(guild.client, guild.id, quiz.panelChannelId);
      await old?.messages.delete(quiz.panelMessageId).catch(() => null);
    }
    store.setQuizPanel(guild.id, quiz.id, channel.id, message.id);
    store.addEvent(guild.id, quiz.id, "posted", actorId, `#${"name" in channel ? channel.name : channel.id}`);
    const fresh = store.getQuiz(guild.id, quiz.id) ?? quiz;
    return { url: message.url, quiz: fresh };
  } catch (error) {
    log.warn(`Couldn't post the panel for quiz #${quiz.id}:`, error);
    return { error: "Dreamliner couldn't post in that channel. Check it can send messages there." };
  }
}

/** Re-renders the existing panel (if any). A deleted panel is forgotten quietly. */
export async function refreshPanel(guild: Guild, quiz: Quiz): Promise<void> {
  if (!quiz.panelChannelId || !quiz.panelMessageId) return;
  const channel = await fetchGuildTextChannel(guild.client, guild.id, quiz.panelChannelId);
  if (!channel) return;
  try {
    const message = await channel.messages.fetch(quiz.panelMessageId);
    const body = panelPayload(quiz, store.listQuestions(quiz.id).length, { players: players(quiz) }, quizIsOpen(quiz, Date.now()));
    await message.edit({ components: body.components, flags: body.flags, allowedMentions: { parse: [] } });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 10008) store.setQuizPanel(guild.id, quiz.id, null, null);
    else log.warn(`Couldn't refresh the panel for quiz #${quiz.id}:`, error);
  }
}
