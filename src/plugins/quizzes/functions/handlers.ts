/**
 * Button, select menu and modal routing for every `dl:quiz:` component: panel Start and
 * Leaderboard, the ephemeral run (answers, typed-answer modal, Next, review, results) and live
 * trivia (answers, host controls, "My score").
 */
import {
  MessageFlags,
  type ButtonInteraction,
  type GuildMember,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";
import { translatorFor } from "../../../i18n/index.js";
import { parseQuizId, QUIZ_PREFIX } from "./customIds.js";
import { answerLive, liveControl, liveStanding } from "./live.js";
import { answerModal, type QuizPayload } from "./render.js";
import { beginAttempt, leaderboardFor, loadOwnAttempt, nextQuestion, renderCurrent, resultsFor, reviewFor, startScreen, submitAnswer, type Screen } from "./run.js";

type Repliable = MessageComponentInteraction | ModalSubmitInteraction;

async function errorReply(interaction: Repliable, title: string, body: string, tone: "error" | "warning" | "success" | "neutral" = "error"): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const payload = resultReply(title, body, true, guildResultOptions(interaction.client, guildConfig, { tone }));
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

function isEphemeralSource(interaction: Repliable): boolean {
  const message = "message" in interaction ? interaction.message : null;
  return Boolean(message?.flags?.has(MessageFlags.Ephemeral));
}

/** Shows a run screen: replaces the ephemeral run message in place, or opens a new ephemeral one. */
async function show(interaction: Repliable, screen: Screen, mode: "auto" | "new" = "auto"): Promise<void> {
  if (!screen.ok) {
    await errorReply(interaction, screen.title, screen.body);
    return;
  }
  const p: QuizPayload = screen.payload;
  const inPlace = mode === "auto" && isEphemeralSource(interaction) && (interaction.isMessageComponent() || (interaction.isModalSubmit() && interaction.isFromMessage()));
  if (inPlace) {
    const edit = { components: p.components, flags: MessageFlags.IsComponentsV2 as number, allowedMentions: p.allowedMentions };
    if (interaction.isMessageComponent()) await interaction.update(edit);
    else if (interaction.isModalSubmit() && interaction.isFromMessage()) await interaction.update(edit);
    return;
  }
  await interaction.reply({ components: p.components, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: p.allowedMentions });
}

async function guard(interaction: Repliable): Promise<GuildMember | null> {
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply(t("common.serverOnlyTitle", "Server only"), t("common.serverOnlyBody", "This command can only be used in a server."), true));
    return null;
  }
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "quizzes")) {
    await errorReply(interaction, t("quizzes.disabledTitle", "Quizzes are off"), t("quizzes.disabledBody", "Quizzes are turned off in this server."));
    return null;
  }
  const member = interaction.member && "roles" in interaction.member && "cache" in (interaction.member.roles as object)
    ? (interaction.member as GuildMember)
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await errorReply(interaction, t("common.memberErrorTitle", "Member error"), t("common.memberErrorBody", "Could not resolve member."));
    return null;
  }
  return member;
}

export function isQuizCustomId(customId: string): boolean {
  return customId.startsWith(QUIZ_PREFIX);
}

export async function handleQuizButton(interaction: ButtonInteraction): Promise<boolean> {
  const id = parseQuizId(interaction.customId);
  if (!id) return false;
  const member = await guard(interaction);
  if (!member) return true;

  switch (id.kind) {
    case "start":
      await show(interaction, await startScreen(member, id.quizId), "new");
      return true;
    case "begin":
      await show(interaction, await beginAttempt(member, id.quizId));
      return true;
    case "leaderboard":
      await show(interaction, await leaderboardFor(member, id.quizId, true), "new");
      return true;
    case "answer":
      await show(interaction, await submitAnswer(member, id.attemptId, id.index, { kind: "option", display: id.option }));
      return true;
    case "type": {
      const loaded = loadOwnAttempt(member.guild.id, member.id, id.attemptId);
      if ("error" in loaded) {
        await errorReply(interaction, "Not your quiz", loaded.error);
        return true;
      }
      const { quiz, questions, attempt } = loaded;
      const question = questions.find((q) => q.id === attempt.questionOrder[id.index]);
      if (attempt.status !== "in_progress" || attempt.currentIndex !== id.index || attempt.awaitingNext || !question) {
        await show(interaction, await renderCurrent(member.guild, quiz, questions, attempt));
        return true;
      }
      await interaction.showModal(answerModal(attempt.id, id.index, question) as never);
      return true;
    }
    case "next":
      await show(interaction, await nextQuestion(member, id.attemptId, id.index));
      return true;
    case "review":
      await show(interaction, await reviewFor(member, id.attemptId, id.page));
      return true;
    case "results":
      await show(interaction, await resultsFor(member, id.attemptId));
      return true;
    case "liveAnswer": {
      const r = await answerLive(member, id.gameId, id.index, id.option);
      await errorReply(interaction, r.title, r.body, r.tone);
      return true;
    }
    case "liveGo":
    case "liveStop": {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await liveControl(member, id.gameId, id.kind === "liveGo" ? "go" : "stop");
      const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
      await interaction.editReply(resultEdit(r.title, r.body, guildResultOptions(interaction.client, guildConfig, { tone: r.tone })));
      return true;
    }
    case "liveMe": {
      const r = liveStanding(member, id.gameId);
      await errorReply(interaction, r.title, r.body, r.tone);
      return true;
    }
    default:
      return false;
  }
}

export async function handleQuizSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const id = parseQuizId(interaction.customId);
  if (!id || id.kind !== "multi") return false;
  const member = await guard(interaction);
  if (!member) return true;
  const display = interaction.values.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 25);
  await show(interaction, await submitAnswer(member, id.attemptId, id.index, { kind: "options", display }));
  return true;
}

export async function handleQuizModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const id = parseQuizId(interaction.customId);
  if (!id || id.kind !== "modal") return false;
  const member = await guard(interaction);
  if (!member) return true;
  const text = interaction.fields.getTextInputValue("answer") ?? "";
  await show(interaction, await submitAnswer(member, id.attemptId, id.index, { kind: "text", text }));
  return true;
}
