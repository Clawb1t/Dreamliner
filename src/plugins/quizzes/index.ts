import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zQuizzesConfig } from "../../config/schemas/quizzes.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { getLogger } from "../../core/logger.js";
import { quizzesCommands } from "./commands.js";
import { processQuizSchedule } from "./functions/scheduler.js";
import { recoverLiveGames, setLiveClient } from "./functions/live.js";

const log = getLogger("quizzes");

export const quizzesPlugin = definePlugin({
  name: "quizzes",
  configSchema: zQuizzesConfig,
  slashCommands: quizzesCommands,
  onLoad: async (ctx) => {
    setLiveClient(ctx.client);
    registerIntervalTask({ id: "quizzes:schedule", intervalMs: 30_000, run: processQuizSchedule });
    const recover = async () => {
      await recoverLiveGames(ctx.client);
      await processQuizSchedule(ctx.client);
    };
    // Live games can't resume their timers after a restart: end them and say so once the client is ready.
    if (ctx.client.isReady()) void recover().catch((error) => log.error("Quiz restart recovery failed:", error));
    else ctx.client.once(Events.ClientReady, () => void recover().catch((error) => log.error("Quiz restart recovery failed:", error)));
  },
});

export { handleQuizButton, handleQuizSelect, handleQuizModal, isQuizCustomId } from "./functions/handlers.js";
export { QUIZ_PREFIX } from "./functions/customIds.js";
export { handleQuizAutocomplete } from "./commands.js";
