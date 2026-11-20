/**
 * The quizzes background pass (every 30s, and once on boot): closes quizzes whose close time came,
 * refreshes panels of quizzes that just opened, and closes abandoned attempts. Passes never overlap.
 */
import type { Client } from "discord.js";
import { getLogger } from "../../../core/logger.js";
import { refreshPanel } from "./panel.js";
import { expireStaleAttempts } from "./run.js";
import * as store from "./store.js";

const log = getLogger("quizzes");

let running = false;
let lastPass = Date.now() - 5 * 60_000;

export async function processQuizSchedule(client: Client): Promise<void> {
  if (running) return;
  running = true;
  const now = new Date();
  try {
    for (const quiz of store.quizzesDueToClose(now)) {
      const closed = store.setQuizStatus(quiz.guildId, quiz.id, "closed");
      if (!closed) continue;
      store.addEvent(quiz.guildId, quiz.id, "closed", null, "On schedule");
      const guild = client.guilds.cache.get(quiz.guildId);
      if (guild) await refreshPanel(guild, closed).catch((error) => log.warn(`Panel refresh failed for quiz #${quiz.id}:`, error));
    }
    for (const quiz of store.quizzesJustOpened(now, new Date(lastPass - 1000))) {
      store.addEvent(quiz.guildId, quiz.id, "opened", null, "On schedule");
      const guild = client.guilds.cache.get(quiz.guildId);
      if (guild) await refreshPanel(guild, quiz).catch((error) => log.warn(`Panel refresh failed for quiz #${quiz.id}:`, error));
    }
    const expired = expireStaleAttempts();
    if (expired) log.info(`Closed ${expired} abandoned quiz attempt(s).`);
  } catch (error) {
    log.error("Quiz schedule pass failed:", error);
  } finally {
    lastPass = now.getTime();
    running = false;
  }
}
