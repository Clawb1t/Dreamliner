import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import { generateStructured, generateText, type ChatTurn } from "../core/ai/client.js";
import { consumeAiGate } from "../core/ai/gate.js";
import { getAiGateStatus } from "../core/ai/usage.js";
import { AI_TASKS, isKnownAiTask, type AiTaskContext } from "../core/ai/prompts.js";
import {
  AI_WIZARDS,
  ANSWER_KINDS,
  isKnownAiWizard,
  type AiWizardContext,
  type AiWizardTurn,
  type AnswerKind,
} from "../core/ai/wizards.js";
import { issueWizardSessionToken, verifyWizardSessionToken } from "../core/ai/wizardSession.js";

export async function getAiStatus(guildId: string) {
  return getAiGateStatus(guildId);
}

export async function generateAiCopy(
  guildId: string,
  body: { task?: string; context?: AiTaskContext },
): Promise<
  | { ok: true; text: string; oneActive: boolean; freeUsesRemaining: number }
  | { ok: false; error: string; status: number; freeUsesRemaining: number }
> {
  const task = body.task?.trim() ?? "";
  if (!isKnownAiTask(task)) {
    return { ok: false, error: `Unknown Autopilot task: ${task}`, status: 400, freeUsesRemaining: 0 };
  }

  const gate = await consumeAiGate(guildId);
  if (!gate.ok) return gate;

  const definition = AI_TASKS[task];
  const context = body.context ?? {};
  const text = await generateText({
    system: definition.system,
    prompt: definition.buildPrompt(context),
    maxTokens: definition.maxTokens,
  });

  return { ok: true, text, oneActive: gate.oneActive, freeUsesRemaining: gate.freeUsesRemaining };
}

function resolveWizardContext(guild: Guild): AiWizardContext {
  const channels = [...guild.channels.cache.values()];
  return {
    guildName: guild.name,
    voiceChannels: channels
      .filter((ch) => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)
      .map((ch) => ({ id: ch.id, name: ch.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    textChannels: channels
      .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
      .map((ch) => ({ id: ch.id, name: ch.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    categories: channels
      .filter((ch) => ch.type === ChannelType.GuildCategory)
      .map((ch) => ({ id: ch.id, name: ch.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    roles: [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id)
      .map((role) => ({ id: role.id, name: role.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    emojis: [...guild.emojis.cache.values()]
      .filter((emoji) => Boolean(emoji.name))
      .map((emoji) => ({ id: emoji.id, name: emoji.name!, animated: Boolean(emoji.animated) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export type AiWizardResult =
  | {
      ok: true;
      action: "ask" | "ready";
      question: string | null;
      answerKind: AnswerKind | null;
      quickReplies: string[] | null;
      config: Record<string, unknown> | null;
      summary: string | null;
      sessionToken: string;
      freeUsesRemaining: number;
    }
  | { ok: false; error: string; status: number; freeUsesRemaining: number };

export async function runAiWizard(
  guild: Guild,
  guildId: string,
  body: { wizard?: string; sessionToken?: string; transcript?: ChatTurn[]; answer?: string },
): Promise<AiWizardResult> {
  const wizardId = body.wizard?.trim() ?? "";
  if (!isKnownAiWizard(wizardId)) {
    return { ok: false, error: `Unknown Autopilot wizard: ${wizardId}`, status: 400, freeUsesRemaining: 0 };
  }
  const definition = AI_WIZARDS[wizardId];

  const ctx = resolveWizardContext(guild);
  if (definition.requiresEntity && ctx[definition.requiresEntity.kind].length === 0) {
    return { ok: false, error: definition.requiresEntity.message, status: 400, freeUsesRemaining: 0 };
  }

  const hasValidSession = verifyWizardSessionToken(guildId, body.sessionToken);
  let freeUsesRemaining = 0;
  if (!hasValidSession) {
    const gate = await consumeAiGate(guildId);
    if (!gate.ok) return gate;
    freeUsesRemaining = gate.freeUsesRemaining;
  }

  const transcript = [...(body.transcript ?? [])];
  if (body.answer?.trim()) {
    transcript.push({ role: "user", content: body.answer.trim() });
  }
  const questionsAsked = transcript.filter((turn) => turn.role === "assistant").length;

  const messages: ChatTurn[] = [
    { role: "system", content: definition.buildSystemPrompt(ctx, questionsAsked) },
    ...transcript,
  ];

  const raw = await generateStructured({
    messages,
    schemaName: `ai_wizard_${wizardId}`,
    schema: definition.buildResultSchema(ctx),
    maxTokens: 800,
  });
  const turn = raw as AiWizardTurn & { question?: string | null; summary?: string | null; config?: unknown };

  const sessionToken = hasValidSession ? body.sessionToken! : issueWizardSessionToken(guildId);

  if (turn.action === "ready") {
    const config = (turn as { config: Record<string, unknown> | null }).config;
    if (!config || typeof config !== "object") {
      return { ok: false, error: "Autopilot did not return a valid setup.", status: 502, freeUsesRemaining };
    }
    const validationError = definition.validateConfig?.(config, ctx);
    if (validationError) {
      return { ok: false, error: validationError, status: 502, freeUsesRemaining };
    }
    return {
      ok: true,
      action: "ready",
      question: null,
      answerKind: null,
      quickReplies: null,
      config,
      summary: (turn as { summary?: string | null }).summary ?? "Setup ready.",
      sessionToken,
      freeUsesRemaining,
    };
  }

  const rawAnswerKind = (turn as { answerKind?: string }).answerKind;
  const answerKind: AnswerKind = (ANSWER_KINDS as readonly string[]).includes(rawAnswerKind ?? "")
    ? (rawAnswerKind as AnswerKind)
    : "text";

  const rawQuickReplies = (turn as { quickReplies?: unknown }).quickReplies;
  const quickReplies = Array.isArray(rawQuickReplies)
    ? rawQuickReplies.filter((reply): reply is string => typeof reply === "string" && reply.trim().length > 0).slice(0, 4)
    : [];

  return {
    ok: true,
    action: "ask",
    question: (turn as { question?: string | null }).question ?? "Can you tell me more?",
    answerKind,
    quickReplies: quickReplies.length > 0 ? quickReplies : null,
    config: null,
    summary: null,
    sessionToken,
    freeUsesRemaining,
  };
}
