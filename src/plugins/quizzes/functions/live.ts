/**
 * Live trivia: a host runs a graded quiz in a channel; everyone answers each question with buttons
 * before the timer, right answers score more the faster they come (plus streak bonuses), the
 * scores show between questions and a podium closes the game.
 *
 * The game row is the source of truth; timers only call `advance()`, which moves the row from one
 * phase to the next with a conditional update, so a stop, a timer and a "Start now" can never all
 * win. One game per channel (partial unique index). If the bot restarts mid-game, boot recovery
 * ends it and says so. If the game message is deleted, the game reposts it and carries on.
 */
import { ButtonStyle, ComponentType, type Client, type ComponentInContainerData, type Guild, type GuildMember } from "discord.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { quizId as cid } from "./customIds.js";
import { livePoints, rankLive } from "./scoring.js";
import { newSeed, seededRandom, shuffled } from "./shuffle.js";
import { getQuizzesConfig, memberCan } from "./run.js";
import {
  button,
  DEFAULT_QUIZ_COLOR,
  LETTER_EMOJI,
  payload,
  plural,
  QUIZ_EMOJI,
  RANK_EMOJI,
  rows,
  separator,
  text,
  ts,
  type QuizPayload,
} from "./render.js";
import * as store from "./store.js";
import type { Quiz, QuizQuestion } from "./types.js";

const log = getLogger("quizzes");

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const countRefresh = new Map<number, ReturnType<typeof setTimeout>>();
const advancing = new Set<number>();
let liveClient: Client | null = null;

export function setLiveClient(client: Client): void {
  liveClient = client;
}

/** Live games use single choice and true/false questions with a right answer. */
export function isLivePlayable(q: QuizQuestion): boolean {
  return (q.type === "single" || q.type === "truefalse") && q.options.length >= 2 && q.options.some((o) => o.correct) && Boolean(q.prompt);
}

function schedule(gameId: number, ms: number): void {
  const existing = timers.get(gameId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(gameId);
    void advance(gameId).catch((error) => log.error(`Live game #${gameId} failed to advance:`, error));
  }, Math.max(0, ms));
  timer.unref?.();
  timers.set(gameId, timer);
}

function clearTimers(gameId: number): void {
  const t = timers.get(gameId);
  if (t) clearTimeout(t);
  timers.delete(gameId);
  const c = countRefresh.get(gameId);
  if (c) clearTimeout(c);
  countRefresh.delete(gameId);
}

// -- Screens -----------------------------------------------------------------------------------------

function standingsLines(game: store.LiveGame, limit: number): string[] {
  const ranked = rankLive(store.livePlayers(game.id).map((p) => ({ ...p, joinedAt: p.joinedAt.getTime() })));
  return ranked.slice(0, limit).map((p, i) => `${i < 3 ? RANK_EMOJI[i] : `**${i + 1}.**`} <@${p.userId}> · **${p.score.toLocaleString("en-US")}**${p.streak >= 3 ? ` ${QUIZ_EMOJI.fire} ${p.streak}` : ""}`);
}

function lobbyPayload(game: store.LiveGame, quiz: Quiz): QuizPayload {
  const starts = game.phaseEndsAt ? `Starting ${ts(game.phaseEndsAt)}` : "Starting now";
  const children: ComponentInContainerData[] = [
    text(`-# ${QUIZ_EMOJI.live} Live trivia\n### ${quiz.title.slice(0, 200)}\n${starts}`),
  ];
  if (quiz.coverImageUrl) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: quiz.coverImageUrl } }] });
  children.push(
    separator(),
    text(
      [
        `${QUIZ_EMOJI.question} **${plural(game.questionOrder.length, "question", "questions")}**, ${game.questionSeconds}s each`,
        `${QUIZ_EMOJI.person} Hosted by <@${game.hostId}>`,
        game.speedBonus ? `${QUIZ_EMOJI.clock} Faster right answers score more` : `${QUIZ_EMOJI.clock} Every right answer scores the same`,
        `${QUIZ_EMOJI.fire} Streaks add bonus points`,
      ].join("\n"),
    ),
    text("-# Anyone here can play: just press an answer when the question appears."),
    separator(false),
    ...rows([
      button(cid({ kind: "liveGo", gameId: game.id }), "Start now", { style: ButtonStyle.Primary, emoji: QUIZ_EMOJI.play }),
      button(cid({ kind: "liveStop", gameId: game.id }), "Cancel", { emoji: QUIZ_EMOJI.stop }),
    ]),
  );
  return payload(children, quiz.color ?? DEFAULT_QUIZ_COLOR, false);
}

function questionScreen(game: store.LiveGame, quiz: Quiz, question: QuizQuestion, answered: number): QuizPayload {
  const order = game.optionOrders[String(question.id)] ?? question.options.map((o) => o.id);
  const options = order.map((id) => question.options.find((o) => o.id === id)).filter((o): o is NonNullable<typeof o> => Boolean(o));
  const children: ComponentInContainerData[] = [
    text(`-# ${QUIZ_EMOJI.live} ${quiz.title.slice(0, 80)} · Question ${game.currentIndex + 1} of ${game.questionOrder.length}\n### ${question.prompt}`),
  ];
  if (question.imageUrl) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: question.imageUrl } }] });
  if (question.type === "single") children.push(text(options.map((o, i) => `${LETTER_EMOJI[i]} ${o.text}`).join("\n")));
  children.push(
    text(`${QUIZ_EMOJI.clock} Time's up ${game.phaseEndsAt ? ts(game.phaseEndsAt) : "soon"} · ${plural(answered, "answer", "answers")} in`),
    separator(false),
    ...rows(
      options.map((o, i) =>
        button(cid({ kind: "liveAnswer", gameId: game.id, index: game.currentIndex, option: i }), o.text, {
          emoji: question.type === "truefalse" ? (/^true$/i.test(o.text) ? QUIZ_EMOJI.correct : QUIZ_EMOJI.wrong) : LETTER_EMOJI[i],
        }),
      ),
    ),
  );
  return payload(children, quiz.color ?? DEFAULT_QUIZ_COLOR, false);
}

function revealScreen(game: store.LiveGame, quiz: Quiz, question: QuizQuestion): QuizPayload {
  const order = game.optionOrders[String(question.id)] ?? question.options.map((o) => o.id);
  const answers = store.liveAnswersFor(game.id, game.currentIndex);
  const counts = new Map<string, number>();
  for (const a of answers) counts.set(a.optionId, (counts.get(a.optionId) ?? 0) + 1);
  const total = answers.length;
  const optionLines = order
    .map((id, i) => {
      const o = question.options.find((x) => x.id === id);
      if (!o) return null;
      const n = counts.get(id) ?? 0;
      const pct = total ? Math.round((n / total) * 100) : 0;
      const bar = "▰".repeat(Math.round(pct / 10)) + "▱".repeat(10 - Math.round(pct / 10));
      return `${o.correct ? QUIZ_EMOJI.correct : LETTER_EMOJI[i]} ${o.correct ? `**${o.text}**` : o.text}\n-# ${bar} ${n} (${pct}%)`;
    })
    .filter(Boolean);
  const fastest = answers.filter((a) => a.correct).sort((a, b) => a.timeMs - b.timeMs)[0];
  const right = answers.filter((a) => a.correct).length;
  const last = game.currentIndex + 1 >= game.questionOrder.length;
  const children: ComponentInContainerData[] = [
    text(`-# ${QUIZ_EMOJI.live} ${quiz.title.slice(0, 80)} · Question ${game.currentIndex + 1} of ${game.questionOrder.length}\n### ${question.prompt}`),
    text(optionLines.join("\n")),
  ];
  const facts = [`${QUIZ_EMOJI.people} ${right} of ${plural(total, "player", "players")} got it right`];
  if (fastest) facts.push(`${QUIZ_EMOJI.clock} Fastest: <@${fastest.userId}> in ${(fastest.timeMs / 1000).toFixed(1)}s`);
  children.push(text(facts.join("\n")));
  if (question.explanation) children.push(text(`${QUIZ_EMOJI.bulb} ${question.explanation.slice(0, 500)}`));
  const standings = standingsLines(game, 5);
  children.push(separator(), text(`${QUIZ_EMOJI.trophy} **Scores**\n${standings.length ? standings.join("\n") : "Nobody has scored yet."}`));
  children.push(text(`-# ${last ? "Final results" : "Next question"} ${game.phaseEndsAt ? ts(game.phaseEndsAt) : "soon"}`));
  children.push(separator(false), ...rows([button(cid({ kind: "liveMe", gameId: game.id }), "My score", { emoji: QUIZ_EMOJI.person })]));
  return payload(children, quiz.color ?? DEFAULT_QUIZ_COLOR, false);
}

function finalScreen(game: store.LiveGame, quiz: Quiz | null, note: string | null): QuizPayload {
  const ranked = rankLive(store.livePlayers(game.id).map((p) => ({ ...p, joinedAt: p.joinedAt.getTime() })));
  const title = quiz?.title.slice(0, 200) ?? "Live trivia";
  const children: ComponentInContainerData[] = [text(`-# ${QUIZ_EMOJI.live} Live trivia · ${game.status === "cancelled" ? "Ended early" : "Final results"}\n### ${title}`)];
  if (note) children.push(text(note));
  if (ranked.length) {
    const podium = ranked
      .slice(0, 3)
      .map((p, i) => `${RANK_EMOJI[i]} <@${p.userId}> · **${p.score.toLocaleString("en-US")}** pts · ${p.correctCount} right${p.bestStreak >= 3 ? ` · ${QUIZ_EMOJI.fire} best streak ${p.bestStreak}` : ""}`);
    children.push(separator(), text(`${QUIZ_EMOJI.cup} **Podium**\n${podium.join("\n")}`));
    const rest = ranked.slice(3, 10).map((p, i) => `**${i + 4}.** <@${p.userId}> · ${p.score.toLocaleString("en-US")}`);
    if (rest.length) children.push(text(rest.join("\n")));
  } else {
    children.push(separator(), text("Nobody answered any questions this time."));
  }
  const played = Math.max(0, Math.min(game.questionOrder.length, game.currentIndex + 1));
  children.push(text(`-# ${plural(ranked.length, "player", "players")} · ${played} of ${plural(game.questionOrder.length, "question", "questions")} played · Hosted by <@${game.hostId}>`));
  return payload(children, quiz?.color ?? DEFAULT_QUIZ_COLOR, false);
}

// -- Message ---------------------------------------------------------------------------------------

/** Edits the game message; reposts it if it was deleted. Returns false when the channel is gone. */
async function showGame(game: store.LiveGame, body: QuizPayload): Promise<boolean> {
  const client = liveClient;
  if (!client) return false;
  const channel = await fetchGuildTextChannel(client, game.guildId, game.channelId);
  if (!channel) return false;
  const edit = { components: body.components, flags: body.flags, allowedMentions: { parse: [] as [] } };
  if (game.messageId) {
    try {
      const message = await channel.messages.fetch(game.messageId);
      await message.edit(edit);
      return true;
    } catch (error) {
      log.warn(`Live game #${game.id}: couldn't edit its message, posting a new one.`, error instanceof Error ? error.message : error);
    }
  }
  try {
    const sent = await channel.send(body);
    store.setGameMessage(game.id, sent.id);
    game.messageId = sent.id;
    return true;
  } catch (error) {
    log.warn(`Live game #${game.id}: couldn't post in its channel.`, error instanceof Error ? error.message : error);
    return false;
  }
}

// -- Lifecycle ---------------------------------------------------------------------------------------

export type StartLiveInput = { guild: Guild; quiz: Quiz; channelId: string; hostId: string; questionCount?: number | null; questionSeconds?: number | null };

export async function startLiveGame(input: StartLiveInput): Promise<{ game: store.LiveGame } | { error: string }> {
  const { guild, quiz } = input;
  if (quiz.kind !== "graded") return { error: "Personality quizzes can't be played live. Pick a graded quiz." };
  if (quiz.status === "archived") return { error: "This quiz is archived. Reopen it first." };
  const playable = store.listQuestions(quiz.id).filter(isLivePlayable);
  if (!playable.length) return { error: "Live games use single choice and true/false questions, and this quiz has none." };
  const channel = await fetchGuildTextChannel(guild.client, guild.id, input.channelId);
  if (!channel) return { error: "That channel isn't in this server, or Dreamliner can't post there." };
  if (store.runningGameInChannel(channel.id)) return { error: "A live game is already running in that channel." };
  const config = await getQuizzesConfig(guild.id);
  const count = Math.max(1, Math.min(50, playable.length, input.questionCount ?? config.live_max_questions));
  const seconds = Math.max(5, Math.min(120, input.questionSeconds ?? config.live_question_seconds));
  const seed = newSeed();
  const ordered = quiz.settings.shuffleQuestions ? shuffled(playable, seededRandom(seed, "live")) : playable;
  const picked = ordered.slice(0, count);
  const optionOrders: Record<string, string[]> = {};
  for (const q of picked) {
    const opts = quiz.settings.shuffleAnswers && q.type !== "truefalse" ? shuffled(q.options, seededRandom(seed, `live${q.id}`)) : q.options;
    optionOrders[String(q.id)] = opts.map((o) => o.id);
  }
  const now = Date.now();
  const lobbyMs = config.live_lobby_seconds * 1000;
  const game = store.createLiveGame({
    guildId: guild.id,
    quizId: quiz.id,
    channelId: channel.id,
    hostId: input.hostId,
    questionOrder: picked.map((q) => q.id),
    optionOrders,
    phaseEndsAt: lobbyMs > 0 ? new Date(now + lobbyMs) : null,
    questionSeconds: seconds,
    revealSeconds: config.live_reveal_seconds,
    speedBonus: config.live_speed_bonus,
    startedAt: new Date(now),
  });
  if (!game) return { error: "A live game is already running in that channel." };
  store.addEvent(guild.id, quiz.id, "live_started", input.hostId, `#${"name" in channel ? channel.name : channel.id}, ${plural(count, "question", "questions")}`);
  if (!(await showGame(game, lobbyPayload(game, quiz)))) {
    store.transitionGame(game.id, store.RUNNING, { status: "cancelled", endedAt: new Date(), endReason: "Couldn't post in the channel." });
    return { error: "Dreamliner couldn't post in that channel. Check its permissions there." };
  }
  schedule(game.id, lobbyMs);
  return { game: store.getLiveGame(game.id) ?? game };
}

/** Moves a game to its next phase. Timers, "Start now" and recovery all come through here. */
export async function advance(gameId: number): Promise<void> {
  if (advancing.has(gameId)) return;
  advancing.add(gameId);
  try {
    const game = store.getLiveGame(gameId);
    if (!game || !store.RUNNING.includes(game.status)) return;
    const quiz = store.getQuiz(game.guildId, game.quizId);
    if (!quiz) {
      await endGame(game, "cancelled", "The quiz was deleted.");
      return;
    }
    const questions = store.getQuestionsByIds(game.questionOrder);
    const byId = new Map(questions.map((q) => [q.id, q]));

    if (game.status === "question") {
      const question = byId.get(game.questionOrder[game.currentIndex]!);
      store.breakStreaksForMissing(game.id, game.currentIndex);
      const revealMs = game.revealSeconds * 1000;
      const moved = store.transitionGame(game.id, ["question"], { status: "reveal", phaseEndsAt: new Date(Date.now() + revealMs) });
      if (!moved) return;
      if (question && !(await showGame(moved, revealScreen(moved, quiz, question)))) {
        await endGame(moved, "cancelled", "The game channel is gone.");
        return;
      }
      schedule(game.id, revealMs);
      return;
    }

    // lobby or reveal: next question, or the end.
    let next = game.currentIndex + 1;
    while (next < game.questionOrder.length && !byId.get(game.questionOrder[next]!)) next++;
    if (next >= game.questionOrder.length) {
      await endGame(game, "finished", null);
      return;
    }
    const ms = game.questionSeconds * 1000;
    const now = Date.now();
    const moved = store.transitionGame(game.id, ["lobby", "reveal"], {
      status: "question",
      currentIndex: next,
      questionStartedAt: new Date(now),
      phaseEndsAt: new Date(now + ms),
    });
    if (!moved) return;
    if (!(await showGame(moved, questionScreen(moved, quiz, byId.get(moved.questionOrder[next]!)!, 0)))) {
      await endGame(moved, "cancelled", "The game channel is gone.");
      return;
    }
    schedule(game.id, ms);
  } finally {
    advancing.delete(gameId);
  }
}

async function endGame(game: store.LiveGame, status: "finished" | "cancelled", reason: string | null, note: string | null = null): Promise<store.LiveGame | null> {
  clearTimers(game.id);
  const ended = store.transitionGame(game.id, store.RUNNING, { status, endedAt: new Date(), endReason: reason, phaseEndsAt: null });
  if (!ended) return null;
  const quiz = store.getQuiz(game.guildId, game.quizId);
  await showGame(ended, finalScreen(ended, quiz, note ?? (status === "cancelled" && reason ? `${QUIZ_EMOJI.stop} ${reason}` : null)));
  if (quiz) store.addEvent(game.guildId, quiz.id, "live_ended", null, `${plural(store.livePlayers(game.id).length, "player", "players")}${reason ? `, ${reason}` : ""}`);
  return ended;
}

export async function stopLiveGame(game: store.LiveGame, actorId: string): Promise<store.LiveGame | null> {
  return endGame(game, "cancelled", `Stopped by <@${actorId}>.`);
}

/** Boot: games that were running when the bot stopped can't pick up their timers, so end them. */
export async function recoverLiveGames(client: Client): Promise<void> {
  setLiveClient(client);
  for (const game of store.runningGames()) {
    try {
      await endGame(game, "cancelled", "Dreamliner restarted.", `${QUIZ_EMOJI.stop} This game ended because Dreamliner restarted. Here are the scores so far.`);
    } catch (error) {
      log.error(`Couldn't close live game #${game.id} after a restart:`, error);
    }
  }
}

// -- Interactions ----------------------------------------------------------------------------------

function refreshAnswerCount(gameId: number): void {
  if (countRefresh.has(gameId)) return;
  const timer = setTimeout(() => {
    countRefresh.delete(gameId);
    void (async () => {
      const game = store.getLiveGame(gameId);
      if (!game || game.status !== "question") return;
      const quiz = store.getQuiz(game.guildId, game.quizId);
      const question = store.getQuestionsByIds([game.questionOrder[game.currentIndex]!])[0];
      if (!quiz || !question) return;
      await showGame(game, questionScreen(game, quiz, question, store.liveAnswerCount(game.id, game.currentIndex)));
    })().catch(() => null);
  }, 2500);
  timer.unref?.();
  countRefresh.set(gameId, timer);
}

export type LiveReply = { title: string; body: string; tone: "success" | "error" | "warning" | "neutral" };

export async function answerLive(member: GuildMember, gameId: number, index: number, option: number): Promise<LiveReply> {
  const game = store.getLiveGameForGuild(member.guild.id, gameId);
  if (!game || !store.RUNNING.includes(game.status)) return { title: "Game over", body: "This live game has ended.", tone: "warning" };
  if (game.status !== "question" || game.currentIndex !== index) return { title: "Too late", body: "This question is closed. Get ready for the next one!", tone: "warning" };
  const now = Date.now();
  if (game.phaseEndsAt && now > game.phaseEndsAt.getTime() + 750) return { title: "Too late", body: "Time's up for this question.", tone: "warning" };
  if (!(await memberCan(member, "can_take"))) return { title: "Permission denied", body: "You don't have permission to play quizzes here.", tone: "error" };
  const qid = game.questionOrder[index]!;
  const question = store.getQuestionsByIds([qid])[0];
  const optionId = (game.optionOrders[String(qid)] ?? [])[option];
  const chosen = question?.options.find((o) => o.id === optionId);
  if (!question || !chosen) return { title: "Answer not found", body: "That answer isn't on this question.", tone: "error" };
  const startedAt = game.questionStartedAt?.getTime() ?? now;
  const limitMs = game.questionSeconds * 1000;
  const result = store.recordLiveAnswer({
    gameId: game.id,
    questionIndex: index,
    userId: member.id,
    optionId: chosen.id,
    correct: chosen.correct,
    timeMs: now - startedAt,
    score: (streakBefore) => livePoints({ correct: chosen.correct, timeMs: now - startedAt, limitMs, speedBonus: game.speedBonus, streakBefore }),
  });
  if (!result) return { title: "Already answered", body: "You've locked in your answer for this question.", tone: "warning" };
  refreshAnswerCount(game.id);
  const letter = question.type === "truefalse" ? chosen.text : String.fromCharCode(65 + option);
  return { title: "Locked in", body: `Locked in **${letter}** in ${((now - startedAt) / 1000).toFixed(1)}s. The answer shows ${game.phaseEndsAt ? ts(game.phaseEndsAt) : "soon"}.`, tone: "success" };
}

/** Host (or live-game staff) only. */
async function canControl(member: GuildMember, game: store.LiveGame): Promise<boolean> {
  return member.id === game.hostId || (await memberCan(member, "can_host_live")) || (await memberCan(member, "can_manage"));
}

export async function liveControl(member: GuildMember, gameId: number, action: "go" | "stop"): Promise<LiveReply> {
  const game = store.getLiveGameForGuild(member.guild.id, gameId);
  if (!game || !store.RUNNING.includes(game.status)) return { title: "Game over", body: "This live game has already ended.", tone: "warning" };
  if (!(await canControl(member, game))) return { title: "Host only", body: "Only the host or staff who can run live games can do that.", tone: "error" };
  if (action === "stop") {
    await stopLiveGame(game, member.id);
    return { title: "Game stopped", body: "The live game has ended. Final scores are on the game message.", tone: "success" };
  }
  if (game.status !== "lobby") return { title: "Already started", body: "The game is already running.", tone: "warning" };
  clearTimers(game.id);
  await advance(game.id);
  return { title: "Starting", body: "Here comes the first question!", tone: "success" };
}

export function liveStanding(member: GuildMember, gameId: number): LiveReply {
  const game = store.getLiveGameForGuild(member.guild.id, gameId);
  if (!game) return { title: "Game not found", body: "This live game no longer exists.", tone: "error" };
  const ranked = rankLive(store.livePlayers(game.id).map((p) => ({ ...p, joinedAt: p.joinedAt.getTime() })));
  const i = ranked.findIndex((p) => p.userId === member.id);
  if (i < 0) return { title: "Not playing yet", body: "Answer the next question to join in!", tone: "neutral" };
  const p = ranked[i]!;
  return {
    title: "Your score",
    body: `You're **#${i + 1}** of ${ranked.length} with **${p.score.toLocaleString("en-US")}** points, ${p.correctCount} right${p.streak >= 2 ? `, on a ${p.streak} answer streak` : ""}.`,
    tone: "neutral",
  };
}

