import { ChannelType, MessageFlags, SlashCommandBuilder, type AutocompleteInteraction, type GuildMember, type SlashCommandSubcommandBuilder } from "discord.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, discordTs, setEmbedAuthor } from "../../core/embeds.js";
import { formatNumber } from "./functions/matching.js";
import { formatDuration, QUIZ_EMOJI } from "./functions/render.js";
import { quizIsOpen } from "./functions/rules.js";
import { beginAttempt, leaderboardFor, memberCan, startScreen, type Screen } from "./functions/run.js";
import { isLivePlayable, startLiveGame, stopLiveGame } from "./functions/live.js";
import { postPanel } from "./functions/panel.js";
import * as store from "./functions/store.js";
import type { Quiz } from "./functions/types.js";

const PLUGIN = "quizzes";

/** Autocomplete for every `quiz` option: which quizzes fit depends on the subcommand. */
export async function handleQuizAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "quiz" || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  const query = String(focused.value ?? "").toLowerCase().replace(/^#/, "");
  const now = Date.now();
  const all = store.listQuizzes(interaction.guildId);
  const fits = (q: Quiz): boolean => {
    if (group === "live") return q.kind === "graded" && q.status !== "archived";
    if (sub === "take") return quizIsOpen(q, now);
    if (sub === "leaderboard") return q.kind === "graded" && (q.status === "published" || q.status === "closed");
    if (sub === "post") return q.status === "published";
    return q.status !== "draft" || sub === "reset";
  };
  const choices = all
    .filter(fits)
    .filter((q) => !query || String(q.id) === query || q.title.toLowerCase().includes(query) || q.category.toLowerCase().includes(query))
    .slice(0, 25)
    .map((q) => ({ name: `${q.title}${q.kind === "personality" ? " (personality)" : ""}${q.status !== "published" ? ` (${q.status})` : ""}`.slice(0, 100), value: String(q.id) }));
  await interaction.respond(choices);
}

function quizOption(sub: SlashCommandSubcommandBuilder, description = "The quiz (search by name)") {
  return sub.addStringOption((o) => o.setName("quiz").setDescription(description).setRequired(true).setAutocomplete(true));
}

function pickedQuiz(ctx: SlashCommandContext): Quiz | null {
  const raw = ctx.interaction.options.getString("quiz", true).replace(/^#/, "").trim();
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? store.getQuiz(ctx.interaction.guildId!, id) : null;
}

async function notFound(ctx: SlashCommandContext) {
  await ctx.interaction.reply(
    resultReply(ctx.t("quizzes.notFoundTitle", "Quiz not found"), ctx.t("quizzes.notFoundBody", "Pick a quiz from the list as you type."), true, slashResultOptions(ctx, { tone: "error" })),
  );
}

async function sendScreen(ctx: SlashCommandContext, screen: Screen) {
  if (!screen.ok) {
    await ctx.interaction.reply(resultReply(screen.title, screen.body, true, slashResultOptions(ctx, { tone: "error" })));
    return;
  }
  await ctx.interaction.reply({ components: screen.payload.components, flags: screen.payload.flags | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

function scoreText(quiz: Quiz | null, a: { score: number; maxScore: number; percent: number; passed: boolean | null; outcomeId: string | null; status: string }): string {
  if (a.status === "in_progress") return "In progress";
  if (quiz?.kind === "personality") return quiz.outcomes.find((o) => o.id === a.outcomeId)?.title ?? "No result";
  const pass = a.passed === true ? ` ${QUIZ_EMOJI.award}` : "";
  return `**${formatNumber(a.score)}**/${formatNumber(a.maxScore)} (${formatNumber(a.percent)}%)${pass}${a.status === "expired" ? " · ran out" : ""}`;
}

export const quizzesCommands: SlashCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data: new SlashCommandBuilder()
      .setName("quiz")
      .setDescription("Take quizzes, see scores and run live trivia")
      .addSubcommand((sub) => quizOption(sub, "The quiz to take").setName("take").setDescription("Take a quiz"))
      .addSubcommand((sub) => sub.setName("list").setDescription("See the quizzes you can take"))
      .addSubcommand((sub) => quizOption(sub).setName("leaderboard").setDescription("Top scores on a quiz"))
      .addSubcommand((sub) =>
        sub
          .setName("results")
          .setDescription("Your quiz results, or a member's")
          .addUserOption((o) => o.setName("member").setDescription("See this member's attempts (staff)")),
      )
      .addSubcommand((sub) =>
        quizOption(sub, "The quiz to post")
          .setName("post")
          .setDescription("Post a quiz panel with a Start button")
          .addChannelOption((o) => o.setName("channel").setDescription("Where to post it (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("live")
          .setDescription("Live trivia in this channel")
          .addSubcommand((sub) =>
            quizOption(sub, "The quiz to play")
              .setName("start")
              .setDescription("Start a live trivia game here")
              .addIntegerOption((o) => o.setName("questions").setDescription("How many questions (default from settings)").setMinValue(1).setMaxValue(50))
              .addIntegerOption((o) => o.setName("seconds").setDescription("Seconds to answer each question").setMinValue(5).setMaxValue(120)),
          )
          .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the live game in this channel")),
      )
      .addSubcommand((sub) =>
        quizOption(sub)
          .setName("reset")
          .setDescription("Clear a member's attempts on a quiz so they can take it again")
          .addUserOption((o) => o.setName("member").setDescription("Whose attempts to clear").setRequired(true)),
      ),
    execute: async (ctx) => {
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const t = ctx.t;

      if (group === "live") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_host_live");
        if (!auth) return;
        if (sub === "start") {
          const quiz = pickedQuiz(ctx);
          if (!quiz) return notFound(ctx);
          await ctx.interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const result = await startLiveGame({
            guild: ctx.interaction.guild!,
            quiz,
            channelId: ctx.interaction.channelId,
            hostId: auth.member.id,
            questionCount: ctx.interaction.options.getInteger("questions"),
            questionSeconds: ctx.interaction.options.getInteger("seconds"),
          });
          if ("error" in result) {
            await ctx.interaction.editReply(resultEdit(t("quizzes.liveFailedTitle", "Couldn't start"), result.error, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
          const skipped = store.listQuestions(quiz.id).filter((q) => !isLivePlayable(q)).length;
          await ctx.interaction.editReply(
            resultEdit(
              t("quizzes.liveStartedTitle", "Live game ready"),
              t("quizzes.liveStartedBody", "**{title}** is about to start here with {count} questions.", { title: quiz.title, count: result.game.questionOrder.length }) +
                (skipped ? `\n-# ${t("quizzes.liveSkipped", "{count} typed, number or multiple select questions were left out: live games use buttons only.", { count: skipped })}` : ""),
              slashResultOptions(ctx, { tone: "success" }),
            ),
          );
          return;
        }
        const game = store.runningGameInChannel(ctx.interaction.channelId);
        if (!game || game.guildId !== guildId) {
          await ctx.interaction.reply(resultReply(t("quizzes.noLiveTitle", "No live game"), t("quizzes.noLiveBody", "There's no live game running in this channel."), true, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }
        await ctx.interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await stopLiveGame(game, auth.member.id);
        await ctx.interaction.editReply(resultEdit(t("quizzes.liveStoppedTitle", "Game stopped"), t("quizzes.liveStoppedBody", "The live game has ended. Final scores are on the game message."), slashResultOptions(ctx, { tone: "success" })));
        return;
      }

      if (sub === "take") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_take");
        if (!auth) return;
        const quiz = pickedQuiz(ctx);
        if (!quiz) return notFound(ctx);
        const intro = await startScreen(auth.member, quiz.id);
        // Resuming an attempt skips straight back to the question.
        if (intro.ok && store.getOpenAttempt(quiz.id, auth.member.id)) return sendScreen(ctx, await beginAttempt(auth.member, quiz.id));
        return sendScreen(ctx, intro);
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_take");
        if (!auth) return;
        const now = Date.now();
        const quizzes = store.listQuizzes(guildId).filter((q) => quizIsOpen(q, now) || (q.status === "published" && q.opensAt && q.opensAt.getTime() > now));
        const counts = store.questionCounts(quizzes.map((q) => q.id));
        const lines = quizzes.slice(0, 20).map((q) => {
          const n = counts.get(q.id) ?? 0;
          const asked = q.settings.poolSize > 0 ? Math.min(q.settings.poolSize, n) : n;
          const when = q.opensAt && q.opensAt.getTime() > now ? `opens ${discordTs(q.opensAt)}` : q.closesAt ? `closes ${discordTs(q.closesAt)}` : "";
          const mine = store.memberAttemptStats(q.id, auth.member.id).finished;
          return `${q.kind === "personality" ? QUIZ_EMOJI.shine : QUIZ_EMOJI.quiz} **${q.title}** · ${asked} ${asked === 1 ? "question" : "questions"}${when ? ` · ${when}` : ""}${mine ? ` · ${QUIZ_EMOJI.correct} taken` : ""}`;
        });
        const embed = setEmbedAuthor(baseEmbed(), t("quizzes.listTitle", "Quizzes"), ctx.client, commandHeader(ctx.guildConfig));
        embed.setDescription(
          lines.length
            ? `${lines.join("\n")}\n-# ${t("quizzes.listHint", "Take one with /quiz take.")}`.slice(0, 4000)
            : t("quizzes.noneOpen", "There are no quizzes to take right now."),
        );
        await ctx.interaction.reply(embedReply(embed, true));
        return;
      }

      if (sub === "leaderboard") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_take");
        if (!auth) return;
        const quiz = pickedQuiz(ctx);
        if (!quiz) return notFound(ctx);
        const screen = await leaderboardFor(auth.member, quiz.id, ctx.ephemeral);
        if (!screen.ok) return sendScreen(ctx, screen);
        await ctx.interaction.reply({ components: screen.payload.components, flags: screen.payload.flags, allowedMentions: { parse: [] } });
        return;
      }

      if (sub === "results") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_take");
        if (!auth) return;
        const target = ctx.interaction.options.getUser("member");
        if (target && target.id !== auth.member.id && !(await memberCan(auth.member, "can_view_results"))) {
          await ctx.interaction.reply(resultReply(t("common.permissionDeniedTitle", "Permission denied"), t("quizzes.resultsOthers", "You can only see your own results."), true, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const userId = target?.id ?? auth.member.id;
        const { attempts, total } = store.listAttempts(guildId, { userId, limit: 15 });
        const quizzes = new Map(store.listQuizzes(guildId).map((q) => [q.id, q]));
        const lines = attempts.map((a) => {
          const quiz = quizzes.get(a.quizId) ?? null;
          return `**${quiz?.title ?? "Deleted quiz"}** · ${scoreText(quiz, a)} · ${a.durationMs !== null ? `${formatDuration(a.durationMs)} · ` : ""}${discordTs(a.finishedAt ?? a.startedAt)}`;
        });
        const embed = setEmbedAuthor(
          baseEmbed(),
          target && target.id !== auth.member.id ? t("quizzes.resultsTitleFor", "Quiz results: {name}", { name: target.username }) : t("quizzes.resultsTitle", "Your quiz results"),
          ctx.client,
          commandHeader(ctx.guildConfig),
        );
        embed.setDescription(
          lines.length
            ? `${lines.join("\n")}${total > attempts.length ? `\n-# ${t("quizzes.resultsMore", "Showing the latest {shown} of {total}.", { shown: attempts.length, total })}` : ""}`.slice(0, 4000)
            : target && target.id !== auth.member.id
              ? t("quizzes.resultsNoneFor", "<@{user}> hasn't taken any quizzes here yet.", { user: userId })
              : t("quizzes.resultsNone", "You haven't taken any quizzes here yet. Try /quiz list."),
        );
        await ctx.interaction.reply({ ...embedReply(embed, true), allowedMentions: { parse: [] } });
        return;
      }

      if (sub === "post") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        const quiz = pickedQuiz(ctx);
        if (!quiz) return notFound(ctx);
        await ctx.interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channelId = ctx.interaction.options.getChannel("channel")?.id ?? ctx.interaction.channelId;
        const result = await postPanel(ctx.interaction.guild!, quiz, channelId, auth.member.id);
        if ("error" in result) {
          await ctx.interaction.editReply(resultEdit(t("quizzes.postFailedTitle", "Couldn't post"), result.error, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await ctx.interaction.editReply(
          resultEdit(t("quizzes.postedTitle", "Panel posted"), t("quizzes.postedBody", "**{title}** is ready to play in <#{channel}>. [Open it]({url})", { title: quiz.title, channel: channelId, url: result.url }), slashResultOptions(ctx, { tone: "success" })),
        );
        return;
      }

      if (sub === "reset") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        const quiz = pickedQuiz(ctx);
        if (!quiz) return notFound(ctx);
        const target = ctx.interaction.options.getUser("member", true);
        const deleted = store.resetAttempts(guildId, quiz.id, target.id);
        if (deleted) store.addEvent(guildId, quiz.id, "reset", auth.member.id, `@${target.username}, ${deleted} ${deleted === 1 ? "attempt" : "attempts"}`);
        await ctx.interaction.reply(
          resultReply(
            t("quizzes.resetTitle", "Attempts reset"),
            deleted
              ? t("quizzes.resetBody", "Cleared {count} of <@{user}>'s attempts on **{title}**. They can take it again.", { count: deleted, user: target.id, title: quiz.title })
              : t("quizzes.resetNone", "<@{user}> has no attempts on **{title}**.", { user: target.id, title: quiz.title }),
            true,
            slashResultOptions(ctx, { tone: deleted ? "success" : "warning" }),
          ),
        );
      }
    },
  },
];

export type { GuildMember };
