/**
 * Every quiz screen as Components V2: the public panel, the ephemeral run (intro, question,
 * feedback, results, review, leaderboard), the results-channel post and the live trivia message.
 * App emoji only (QUIZ_EMOJI); the progress bar is plain text blocks.
 */
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  TextInputStyle,
  type APIButtonComponent,
  type APIStringSelectComponent,
  type ComponentInContainerData,
  type TopLevelComponentData,
} from "discord.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { quizId } from "./customIds.js";
import { answerText, correctAnswerText, formatNumber } from "./matching.js";
import { streakCallout } from "./scoring.js";
import type { AttemptAnswer, QuizAttempt, QuizOption, QuizOutcome, QuizQuestion, Quiz } from "./types.js";

export const QUIZ_EMOJI = {
  quiz: "<:icons_education:1544417543064789002>",
  question: "<:icons_question:1544417575864107078>",
  play: "<:icons_play:1544417388408217641>",
  clock: "<:icons_clock:1544417185336664114>",
  hourglass: "<:icons_hoursglass:1544417711864549479>",
  trophy: "<:icons_trophy:1544418249721126922>",
  cup: "<:icons_awardcup:1544417481538670773>",
  award: "<:icons_award:1544417478912770127>",
  correct: "<:icons_Correct:1544417199798886530>",
  wrong: "<:icons_Wrong:1544417460638457937>",
  fire: "<:icons_fire:1544417280375525437>",
  bulb: "<:icons_bulb:1544417162050142428>",
  list: "<:icons_list:1544417562325164173>",
  people: "<:icons_people:1544417371215626262>",
  person: "<:icons_Person:1544417372260278353>",
  live: "<:icons_live:1544417331822993408>",
  stop: "<:icons_stop_streaming:1544418214182649886>",
  retry: "<:icons_try_again:1544418253042876547>",
  view: "<:icons_view:1544417600371429450>",
  left: "<:icons_leftarrow:1544417561008144484>",
  right: "<:icons_rightarrow:1544417401180000337>",
  pen: "<:icons_pen:1544417369709871224>",
  star: "<:icons_star:1544417435636080741>",
  shine: "<:icons_shine1:1544417415813927062>",
  roles: "<:icons_roles:1544417804994871338>",
  locked: "<:icons_locked:1544417721612247171>",
  calendar: "<:icons_calendar1:1544417163019026594>",
  rules: "<:icons_rules:1544417580565921832>",
  loading: "<:icons_loading:1544417333420888074>",
} as const;

/** A to J, for option labels. */
export const LETTER_EMOJI = [
  "<:icons_a:1544418006036390009>",
  "<:icons_b:1544418009014079579>",
  "<:icons_c:1544418014164684960>",
  "<:icons_d:1544418015695736873>",
  "<:icons_e:1544418018048876554>",
  "<:icons_f:1544418019504164924>",
  "<:icons_g:1544418021957967882>",
  "<:icons_h:1544418024587530240>",
  "<:icons_i:1544418027116691476>",
  "<:icons_j:1544418028597411890>",
] as const;

export const RANK_EMOJI = ["<:icons_1:1544417676762292264>", "<:icons_2:1544417991813238868>", "<:icons_3:1544417993449013308>"] as const;

export const DEFAULT_QUIZ_COLOR = 0x5662f5;

export type QuizPayload = { components: TopLevelComponentData[]; flags: number; allowedMentions: { parse: [] } };

function ts(date: Date | number, style: "R" | "f" | "t" = "R"): string {
  const ms = typeof date === "number" ? date : date.getTime();
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatSeconds(sec: number): string {
  if (sec <= 0) return "No limit";
  if (sec % 3600 === 0) return plural(sec / 3600, "hour", "hours");
  if (sec >= 60 && sec % 60 === 0) return plural(sec / 60, "minute", "minutes");
  if (sec > 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return plural(sec, "second", "seconds");
}

/** ▰▰▰▱▱▱▱▱▱▱ */
export function progressBar(done: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.round((Math.max(0, Math.min(done, total)) / total) * width) : 0;
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
}

function text(content: string): ComponentInContainerData {
  return { type: ComponentType.TextDisplay, content: content.slice(0, 3800) };
}

function separator(divider = true): ComponentInContainerData {
  return { type: ComponentType.Separator, divider, spacing: SeparatorSpacingSize.Small };
}

function emojiOf(raw: string): { id?: string; name?: string; animated?: boolean } | undefined {
  const parsed = parseComponentEmoji(raw);
  if (!parsed) return undefined;
  return typeof parsed === "string" ? { name: parsed } : parsed;
}

export function button(
  customId: string,
  label: string,
  options: { style?: ButtonStyle; emoji?: string; disabled?: boolean } = {},
): APIButtonComponent {
  const b: Record<string, unknown> = {
    type: ComponentType.Button,
    custom_id: customId,
    style: options.style ?? ButtonStyle.Secondary,
    label: label.slice(0, 80) || "​",
    disabled: options.disabled ?? false,
  };
  const emoji = options.emoji ? emojiOf(options.emoji) : undefined;
  if (emoji) b.emoji = emoji;
  return b as unknown as APIButtonComponent;
}

function linkButton(url: string, label: string): APIButtonComponent {
  return { type: ComponentType.Button, style: ButtonStyle.Link, label, url } as APIButtonComponent;
}

function rows(buttons: APIButtonComponent[]): ComponentInContainerData[] {
  const out: ComponentInContainerData[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    out.push({ type: ComponentType.ActionRow, components: buttons.slice(i, i + 5) } as unknown as ComponentInContainerData);
  }
  return out;
}

function header(title: string, kicker: string | null, body: string | null, thumbnail: string | null): ComponentInContainerData {
  const content = [kicker ? `-# ${kicker}` : null, `### ${title.slice(0, 200)}`, body || null].filter(Boolean).join("\n").slice(0, 3800);
  if (thumbnail) {
    return {
      type: ComponentType.Section,
      components: [{ type: ComponentType.TextDisplay, content }],
      accessory: { type: ComponentType.Thumbnail, media: { url: thumbnail } },
    };
  }
  return text(content);
}

function container(color: number | null, children: ComponentInContainerData[]): TopLevelComponentData {
  return { type: ComponentType.Container, accentColor: color ?? DEFAULT_QUIZ_COLOR, components: children };
}

function payload(children: ComponentInContainerData[], color: number | null, ephemeral: boolean): QuizPayload {
  return {
    components: [container(color, children)],
    flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] },
  };
}

/** Facts shown on the panel and the intro: questions, limits, attempts, pass mark, window. */
export function quizFacts(quiz: Quiz, questionCount: number): string[] {
  const asked = quiz.settings.poolSize > 0 ? Math.min(quiz.settings.poolSize, questionCount) : questionCount;
  const lines = [`${QUIZ_EMOJI.question} **${plural(asked, "question", "questions")}**${asked < questionCount ? ` picked from ${questionCount}` : ""}`];
  const limits: string[] = [];
  if (quiz.settings.questionTimeLimitSec > 0) limits.push(`${formatSeconds(quiz.settings.questionTimeLimitSec)} per question`);
  if (quiz.settings.quizTimeLimitSec > 0) limits.push(`${formatSeconds(quiz.settings.quizTimeLimitSec)} in total`);
  if (limits.length) lines.push(`${QUIZ_EMOJI.clock} ${limits.join(", ")}`);
  if (quiz.kind === "graded" && quiz.settings.passPercent > 0) {
    lines.push(`${QUIZ_EMOJI.award} Pass with **${quiz.settings.passPercent}%**${quiz.settings.passRoleId ? ` to get <@&${quiz.settings.passRoleId}>` : ""}`);
  }
  if (quiz.kind === "personality") lines.push(`${QUIZ_EMOJI.shine} **${plural(quiz.outcomes.length, "possible result", "possible results")}**`);
  if (quiz.settings.maxAttempts > 0) lines.push(`${QUIZ_EMOJI.retry} ${quiz.settings.maxAttempts === 1 ? "One attempt" : `${quiz.settings.maxAttempts} attempts`}${quiz.settings.cooldownMinutes > 0 ? `, ${formatSeconds(quiz.settings.cooldownMinutes * 60)} apart` : ""}`);
  else if (quiz.settings.cooldownMinutes > 0) lines.push(`${QUIZ_EMOJI.retry} Retake after ${formatSeconds(quiz.settings.cooldownMinutes * 60)}`);
  if (quiz.settings.requiredRoleIds.length) lines.push(`${QUIZ_EMOJI.roles} For ${quiz.settings.requiredRoleIds.map((id) => `<@&${id}>`).join(", ")}`);
  if (quiz.opensAt && quiz.opensAt.getTime() > Date.now()) lines.push(`${QUIZ_EMOJI.calendar} Opens ${ts(quiz.opensAt)}`);
  if (quiz.closesAt && quiz.closesAt.getTime() > Date.now()) lines.push(`${QUIZ_EMOJI.calendar} Closes ${ts(quiz.closesAt)}`);
  return lines;
}

// -- Panel -----------------------------------------------------------------------------------------

export function panelPayload(quiz: Quiz, questionCount: number, stats: { players: number }, open: boolean): QuizPayload {
  const kicker = quiz.kind === "personality" ? "Personality quiz" : quiz.category ? `Quiz · ${quiz.category}` : "Quiz";
  const children: ComponentInContainerData[] = [header(quiz.title, kicker, quiz.description || null, null)];
  if (quiz.coverImageUrl) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: quiz.coverImageUrl } }] });
  children.push(separator());
  const facts = quizFacts(quiz, questionCount);
  if (stats.players > 0) facts.push(`${QUIZ_EMOJI.people} ${plural(stats.players, "member has", "members have")} taken it`);
  children.push(text(facts.join("\n")));
  const status =
    quiz.status === "closed" || (quiz.closesAt && quiz.closesAt.getTime() <= Date.now())
      ? `${QUIZ_EMOJI.locked} This quiz is closed.`
      : quiz.status === "archived"
        ? `${QUIZ_EMOJI.locked} This quiz has been archived.`
        : !open && quiz.opensAt
          ? `${QUIZ_EMOJI.calendar} Opens ${ts(quiz.opensAt)}.`
          : "-# Your answers are private. Only you see the questions while you play.";
  children.push(text(status));
  const buttons = [button(quizId({ kind: "start", quizId: quiz.id }), quiz.kind === "personality" ? "Find out" : "Start quiz", { style: ButtonStyle.Primary, emoji: QUIZ_EMOJI.play, disabled: !open })];
  if (quiz.kind === "graded" && quiz.settings.showLeaderboard) buttons.push(button(quizId({ kind: "leaderboard", quizId: quiz.id }), "Leaderboard", { emoji: QUIZ_EMOJI.trophy }));
  children.push(separator(false), ...rows(buttons));
  return payload(children, quiz.color, false);
}

// -- Intro -----------------------------------------------------------------------------------------

export function introPayload(
  quiz: Quiz,
  questionCount: number,
  info: { resume: { answered: number; total: number } | null; attemptsLeft: number | null; best: { percent: number; rank: number } | null },
): QuizPayload {
  const children: ComponentInContainerData[] = [header(quiz.title, quiz.kind === "personality" ? "Personality quiz" : "Quiz", quiz.description ? quiz.description.slice(0, 600) : null, quiz.coverImageUrl || null)];
  children.push(separator());
  const facts = quizFacts(quiz, questionCount);
  if (quiz.kind === "graded") {
    facts.push(
      quiz.settings.revealMode === "each"
        ? `${QUIZ_EMOJI.bulb} You'll see the right answer after each question`
        : quiz.settings.revealMode === "end"
          ? `${QUIZ_EMOJI.bulb} You'll see the right answers at the end`
          : `${QUIZ_EMOJI.locked} The right answers stay hidden`,
    );
  }
  if (info.attemptsLeft !== null) facts.push(`${QUIZ_EMOJI.retry} ${info.attemptsLeft === 1 ? "This is your last attempt" : `${info.attemptsLeft} attempts left`}`);
  if (info.best) facts.push(`${QUIZ_EMOJI.trophy} Your best: **${info.best.percent}%**, rank #${info.best.rank}`);
  children.push(text(facts.join("\n")));
  if (info.resume) {
    children.push(text(`${QUIZ_EMOJI.hourglass} You're partway through: **${info.resume.answered} of ${info.resume.total}** answered. Pick up where you left off.`));
  } else if (quiz.settings.questionTimeLimitSec > 0 || quiz.settings.quizTimeLimitSec > 0) {
    children.push(text("-# The clock starts when you press Begin. Late answers don't count."));
  }
  children.push(
    separator(false),
    ...rows([button(quizId({ kind: "begin", quizId: quiz.id }), info.resume ? "Continue" : "Begin", { style: ButtonStyle.Primary, emoji: QUIZ_EMOJI.play })]),
  );
  return payload(children, quiz.color, true);
}

// -- Question --------------------------------------------------------------------------------------

export type QuestionScreen = {
  quiz: Quiz;
  attempt: QuizAttempt;
  question: QuizQuestion;
  options: QuizOption[];
  index: number;
  total: number;
  /** When the timer for this question ends (per-question limit or quiz deadline, whichever first). */
  endsAt: number | null;
  deadlineAt: number | null;
};

function questionHead(s: QuestionScreen): string {
  const lines = [
    `-# ${s.quiz.title.slice(0, 80)} · Question ${s.index + 1} of ${s.total}`,
    `${progressBar(s.index, s.total)}${s.quiz.kind === "graded" ? ` · ${formatNumber(s.attempt.score)} pts` : ""}${s.attempt.streak >= 2 ? ` · ${QUIZ_EMOJI.fire} ${s.attempt.streak}` : ""}`,
    `### ${s.question.prompt}`,
  ];
  return lines.join("\n");
}

function timerLine(s: QuestionScreen): string | null {
  const parts: string[] = [];
  if (s.endsAt) parts.push(`${QUIZ_EMOJI.clock} Time's up ${ts(s.endsAt)}`);
  if (s.deadlineAt && (!s.endsAt || s.deadlineAt > s.endsAt + 1000)) parts.push(`${QUIZ_EMOJI.hourglass} Quiz ends ${ts(s.deadlineAt)}`);
  return parts.length ? parts.join(" · ") : null;
}

export function questionPayload(s: QuestionScreen): QuizPayload {
  const children: ComponentInContainerData[] = [text(questionHead(s))];
  if (s.question.imageUrl) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: s.question.imageUrl } }] });
  const t = s.question.type;
  if (t === "single" || t === "multi") {
    children.push(text(s.options.map((o, i) => `${LETTER_EMOJI[i]} ${o.text}`).join("\n")));
  }
  const hint =
    t === "multi"
      ? s.quiz.kind === "graded"
        ? `-# Pick every right answer${s.question.partialCredit ? " (partial credit counts)" : ""}.`
        : "-# Pick all that apply."
      : t === "text"
        ? "-# Type your answer. Spelling is forgiving, capitals and accents don't matter."
        : t === "number"
          ? `-# Type a number${s.question.numberTolerance > 0 ? ". Close enough counts" : ""}.`
          : null;
  const timer = timerLine(s);
  if (hint || timer) children.push(text([timer, hint].filter(Boolean).join("\n")));
  children.push(separator(false));

  if (t === "single") {
    children.push(...rows(s.options.map((o, i) => button(quizId({ kind: "answer", attemptId: s.attempt.id, index: s.index, option: i }), o.text, { emoji: LETTER_EMOJI[i] }))));
  } else if (t === "truefalse") {
    children.push(
      ...rows(
        s.options.map((o, i) =>
          button(quizId({ kind: "answer", attemptId: s.attempt.id, index: s.index, option: i }), o.text, {
            emoji: /^true$/i.test(o.text) ? QUIZ_EMOJI.correct : QUIZ_EMOJI.wrong,
          }),
        ),
      ),
    );
  } else if (t === "multi") {
    const select: APIStringSelectComponent = {
      type: ComponentType.StringSelect,
      custom_id: quizId({ kind: "multi", attemptId: s.attempt.id, index: s.index }),
      placeholder: "Choose your answers",
      min_values: 1,
      max_values: s.options.length,
      options: s.options.map((o, i) => {
        const emoji = emojiOf(LETTER_EMOJI[i]!);
        return { label: o.text.slice(0, 100), value: String(i), ...(emoji ? { emoji } : {}) };
      }),
    } as APIStringSelectComponent;
    children.push({ type: ComponentType.ActionRow, components: [select] } as unknown as ComponentInContainerData);
  } else {
    children.push(...rows([button(quizId({ kind: "type", attemptId: s.attempt.id, index: s.index }), t === "number" ? "Enter a number" : "Type your answer", { style: ButtonStyle.Primary, emoji: QUIZ_EMOJI.pen })]));
  }
  return payload(children, s.quiz.color, true);
}

export function answerModal(attemptId: number, index: number, question: QuizQuestion) {
  return {
    customId: quizId({ kind: "modal", attemptId, index }),
    title: `Question ${index + 1}`.slice(0, 45),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            customId: "answer",
            label: question.prompt.slice(0, 45) || "Your answer",
            style: TextInputStyle.Short,
            required: true,
            maxLength: question.type === "number" ? 30 : 100,
            placeholder: question.type === "number" ? "A number, like 42 or 3.14" : "Your answer",
          },
        ],
      },
    ],
  };
}

// -- Feedback (reveal "each") ----------------------------------------------------------------------

export function feedbackPayload(input: {
  quiz: Quiz;
  attempt: QuizAttempt;
  question: QuizQuestion;
  answer: AttemptAnswer;
  index: number;
  total: number;
  /** The attempt's streak after this answer. */
  streak: number;
}): QuizPayload {
  const { quiz, question, answer } = input;
  const late = answer.late || answer.timedOut;
  const right = Boolean(answer.correct) && !late;
  const partial = !right && !late && answer.credit > 0;
  const verdict = answer.timedOut
    ? `${QUIZ_EMOJI.hourglass} **Out of time.**`
    : answer.late
      ? `${QUIZ_EMOJI.hourglass} **Too late.** That answer came in after the timer.`
      : right
        ? `${QUIZ_EMOJI.correct} **Correct!**${answer.points ? ` +${formatNumber(answer.points)} ${answer.points === 1 ? "point" : "points"}` : ""}`
        : partial
          ? `${QUIZ_EMOJI.correct} **Partly right.** +${formatNumber(answer.points)} of ${formatNumber(question.points)} points`
          : `${QUIZ_EMOJI.wrong} **Not quite.**`;
  const lines = [`-# ${quiz.title.slice(0, 80)} · Question ${input.index + 1} of ${input.total}`, `${progressBar(input.index + 1, input.total)} · ${formatNumber(input.attempt.score)} pts`, `### ${question.prompt}`, verdict];
  if (!answer.timedOut) lines.push(`Your answer: **${answerText(question, answer.answer).slice(0, 300)}**`);
  if (!right) lines.push(`Right answer: **${correctAnswerText(question).slice(0, 300)}**`);
  const callout = right ? streakCallout(input.streak) : null;
  if (callout) lines.push(`${QUIZ_EMOJI.fire} **${callout}**`);
  const children: ComponentInContainerData[] = [text(lines.join("\n"))];
  if (question.explanation) children.push(text(`${QUIZ_EMOJI.bulb} ${question.explanation}`));
  const last = input.index + 1 >= input.total;
  children.push(
    separator(false),
    ...rows([button(quizId({ kind: "next", attemptId: input.attempt.id, index: input.index + 1 }), last ? "See results" : "Next question", { style: ButtonStyle.Primary, emoji: last ? QUIZ_EMOJI.trophy : QUIZ_EMOJI.right })]),
  );
  return payload(children, quiz.color, true);
}

// -- Results ---------------------------------------------------------------------------------------

export type ResultsInfo = {
  quiz: Quiz;
  attempt: QuizAttempt;
  outcome: QuizOutcome | null;
  rank: { rank: number; total: number } | null;
  questionCount: number;
  canRetry: boolean;
  retryNote: string | null;
  rewardNote: string | null;
};

export function resultsPayload(r: ResultsInfo): QuizPayload {
  const { quiz, attempt } = r;
  const children: ComponentInContainerData[] = [];
  const expired = attempt.status === "expired";
  if (quiz.kind === "personality" && r.outcome) {
    const o = r.outcome;
    children.push(header(o.title, `${quiz.title.slice(0, 80)} · Your result`, o.description || null, null));
    if (o.imageUrl) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: o.imageUrl } }] });
    if (r.rewardNote) children.push(text(r.rewardNote));
  } else {
    const passed = attempt.passed;
    const verdict =
      passed === true ? `${QUIZ_EMOJI.award} **You passed!**` : passed === false ? `${QUIZ_EMOJI.wrong} **Not a pass this time.** You needed ${quiz.settings.passPercent}%.` : null;
    const head = [
      `-# ${quiz.title.slice(0, 80)} · ${expired ? "Time ran out" : "Results"}`,
      `## ${formatNumber(attempt.score)} / ${formatNumber(attempt.maxScore)}`,
      `${progressBar(attempt.percent, 100)} **${formatNumber(attempt.percent)}%**`,
      verdict,
    ]
      .filter(Boolean)
      .join("\n");
    children.push(text(head));
    children.push(separator());
    const facts = [`${QUIZ_EMOJI.correct} **${attempt.correctCount}** of ${r.questionCount} right`, `${QUIZ_EMOJI.clock} ${formatDuration(attempt.durationMs)}`];
    if (attempt.bestStreak >= 2) facts.push(`${QUIZ_EMOJI.fire} Best streak **${attempt.bestStreak}**`);
    if (r.rank && quiz.settings.showLeaderboard && !expired) facts.push(`${QUIZ_EMOJI.trophy} Rank **#${r.rank.rank}** of ${r.rank.total}`);
    children.push(text(facts.join("\n")));
    if (r.rewardNote) children.push(text(r.rewardNote));
  }
  if (r.retryNote) children.push(text(`-# ${r.retryNote}`));
  const buttons: APIButtonComponent[] = [];
  if (quiz.settings.allowReview) {
    buttons.push(button(quizId({ kind: "review", attemptId: attempt.id, page: 0 }), "Review answers", { emoji: QUIZ_EMOJI.view }));
  }
  if (quiz.kind === "graded" && quiz.settings.showLeaderboard) buttons.push(button(quizId({ kind: "leaderboard", quizId: quiz.id }), "Leaderboard", { emoji: QUIZ_EMOJI.trophy }));
  if (r.canRetry) buttons.push(button(quizId({ kind: "begin", quizId: quiz.id }), "Try again", { emoji: QUIZ_EMOJI.retry }));
  if (buttons.length) children.push(separator(false), ...rows(buttons));
  return payload(children, r.outcome?.color ?? quiz.color, true);
}

// -- Review ----------------------------------------------------------------------------------------

export const REVIEW_PAGE = 5;

export function reviewPayload(input: { quiz: Quiz; attempt: QuizAttempt; questions: QuizQuestion[]; answers: AttemptAnswer[]; page: number; outcomes: QuizOutcome[] }): QuizPayload {
  const { quiz, attempt } = input;
  const order = attempt.questionOrder;
  const pages = Math.max(1, Math.ceil(order.length / REVIEW_PAGE));
  const page = Math.min(Math.max(0, input.page), pages - 1);
  const byId = new Map(input.questions.map((q) => [q.id, q]));
  const answerBy = new Map(input.answers.map((a) => [a.questionId, a]));
  const showCorrect = quiz.kind === "graded" && quiz.settings.revealMode !== "never";
  const blocks: string[] = [];
  order.slice(page * REVIEW_PAGE, page * REVIEW_PAGE + REVIEW_PAGE).forEach((qid, i) => {
    const n = page * REVIEW_PAGE + i + 1;
    const q = byId.get(qid);
    if (!q) {
      blocks.push(`**${n}.** -# This question was removed from the quiz.`);
      return;
    }
    const a = answerBy.get(qid);
    const lines = [`**${n}. ${q.prompt.slice(0, 300)}**`];
    if (quiz.kind === "personality") {
      lines.push(`${QUIZ_EMOJI.pen} ${a ? answerText(q, a.answer).slice(0, 200) : "No answer"}`);
    } else {
      const icon = !a || a.timedOut || a.late ? QUIZ_EMOJI.hourglass : a.correct ? QUIZ_EMOJI.correct : a.credit > 0 ? QUIZ_EMOJI.correct : QUIZ_EMOJI.wrong;
      const what = !a ? "Not answered" : a.timedOut ? "Out of time" : answerText(q, a.answer).slice(0, 200) + (a.late ? " (too late)" : "");
      lines.push(`${icon} ${what}${a && !a.timedOut ? ` · ${formatNumber(a.points)}/${formatNumber(q.points)}` : ""}`);
      if (showCorrect && !(a?.correct && !a.late)) lines.push(`Right answer: **${correctAnswerText(q).slice(0, 200)}**`);
      if (showCorrect && q.explanation) lines.push(`-# ${q.explanation.slice(0, 300)}`);
    }
    blocks.push(lines.join("\n"));
  });
  const children: ComponentInContainerData[] = [
    text(`-# ${quiz.title.slice(0, 80)} · Review, page ${page + 1} of ${pages}`),
    separator(),
    text(blocks.join("\n\n") || "Nothing to show."),
  ];
  if (quiz.kind === "graded" && quiz.settings.revealMode === "never") children.push(text("-# This quiz keeps its right answers hidden."));
  const nav: APIButtonComponent[] = [
    button(quizId({ kind: "review", attemptId: attempt.id, page: Math.max(0, page - 1) }), "Previous", { emoji: QUIZ_EMOJI.left, disabled: page === 0 }),
    button(quizId({ kind: "review", attemptId: attempt.id, page: Math.min(pages - 1, page + 1) }), "Next", { emoji: QUIZ_EMOJI.right, disabled: page >= pages - 1 }),
    button(quizId({ kind: "results", attemptId: attempt.id }), "Back to results", { emoji: QUIZ_EMOJI.trophy }),
  ];
  children.push(separator(false), ...rows(nav));
  return payload(children, quiz.color, true);
}

// -- Leaderboard -----------------------------------------------------------------------------------

export function leaderboardLines(entries: { userId: string; score: number; maxScore: number; percent: number; durationMs: number | null }[], viewerId: string | null): string[] {
  return entries.map((e, i) => {
    const place = i < 3 ? RANK_EMOJI[i]! : `**${i + 1}.**`;
    const you = viewerId && e.userId === viewerId ? " (you)" : "";
    return `${place} <@${e.userId}>${you} · **${formatNumber(e.score)}**/${formatNumber(e.maxScore)} (${formatNumber(e.percent)}%) · ${formatDuration(e.durationMs)}`;
  });
}

export function leaderboardPayload(
  quiz: Quiz,
  entries: { userId: string; score: number; maxScore: number; percent: number; durationMs: number | null }[],
  viewer: { userId: string; rank: number | null } | null,
  ephemeral: boolean,
): QuizPayload {
  const lines = leaderboardLines(entries, viewer?.userId ?? null);
  const children: ComponentInContainerData[] = [
    header(`${quiz.title.slice(0, 150)}`, `${"Leaderboard"}`, null, null),
    separator(),
    text(lines.length ? lines.join("\n") : `${QUIZ_EMOJI.trophy} Nobody has finished this quiz yet. Be the first!`),
  ];
  if (viewer?.rank && !entries.some((e) => e.userId === viewer.userId)) children.push(text(`-# You're #${viewer.rank}.`));
  children.push(text("-# Best score counts, ties go to the fastest."));
  return payload(children, quiz.color, ephemeral);
}

// -- Results channel post --------------------------------------------------------------------------

export function resultPostPayload(quiz: Quiz, attempt: QuizAttempt, outcome: QuizOutcome | null, questionCount: number): QuizPayload {
  const lines =
    quiz.kind === "personality"
      ? [`<@${attempt.userId}> took **${quiz.title.slice(0, 120)}** and got **${outcome?.title ?? "no result"}**`]
      : [
          `<@${attempt.userId}> finished **${quiz.title.slice(0, 120)}**`,
          `${progressBar(attempt.percent, 100)} **${formatNumber(attempt.score)}/${formatNumber(attempt.maxScore)}** (${formatNumber(attempt.percent)}%) · ${attempt.correctCount} of ${questionCount} right · ${formatDuration(attempt.durationMs)}`,
          attempt.passed === true ? `${QUIZ_EMOJI.award} Passed` : attempt.passed === false ? `${QUIZ_EMOJI.wrong} Didn't pass` : "",
        ];
  const children: ComponentInContainerData[] = [];
  const body = lines.filter(Boolean).join("\n");
  if (outcome?.imageUrl) {
    children.push({ type: ComponentType.Section, components: [{ type: ComponentType.TextDisplay, content: `${QUIZ_EMOJI.quiz} ${body}` }], accessory: { type: ComponentType.Thumbnail, media: { url: outcome.imageUrl } } });
  } else {
    children.push(text(`${QUIZ_EMOJI.quiz} ${body}`));
  }
  return payload(children, outcome?.color ?? quiz.color, false);
}

/** The DM version of the results (no buttons). */
export function resultDmPayload(quiz: Quiz, attempt: QuizAttempt, outcome: QuizOutcome | null, questionCount: number, guildName: string): QuizPayload {
  const base = resultPostPayload(quiz, attempt, outcome, questionCount);
  const extra = text(`-# From ${guildName.slice(0, 100)}`);
  const c = base.components[0] as unknown as { components: ComponentInContainerData[] };
  c.components.push(extra);
  return base;
}

export { linkButton, rows, text, separator, header, payload, plural, ts };
