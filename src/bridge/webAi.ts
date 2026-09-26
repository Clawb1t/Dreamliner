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
import {
  issueSwitchSessionToken,
  issueWizardSessionToken,
  verifySwitchSessionToken,
  verifyWizardSessionToken,
} from "../core/ai/wizardSession.js";
import {
  MAX_SWITCH_IMAGES,
  buildImportDirective,
  isSwitchSource,
  readSwitchScreenshots,
  withMoreToImport,
  type SwitchSource,
} from "../core/ai/switch.js";

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
      /** Switch imports only: whether the screenshot notes still have entries left to bring over. */
      moreToImport?: boolean;
    }
  | { ok: false; error: string; status: number; freeUsesRemaining: number };

/** Only plain text turns come from the browser; images are never accepted back through a transcript. */
function sanitizeTranscript(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (turn): turn is { role: "user" | "assistant"; content: string } =>
        Boolean(turn) &&
        typeof turn === "object" &&
        ((turn as { role?: unknown }).role === "user" || (turn as { role?: unknown }).role === "assistant") &&
        typeof (turn as { content?: unknown }).content === "string",
    )
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 12_000) }))
    .slice(-40);
}

function parseImportFrom(raw: unknown): { source: SwitchSource; category: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { source, category } = raw as { source?: unknown; category?: unknown };
  if (!isSwitchSource(source) || typeof category !== "string" || !category.trim()) return null;
  return { source, category: category.trim().slice(0, 80) };
}

export async function runAiWizard(
  guild: Guild,
  guildId: string,
  body: { wizard?: string; sessionToken?: string; transcript?: unknown; answer?: string; importFrom?: unknown },
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

  const importFrom = parseImportFrom(body.importFrom);
  const hasValidSession =
    verifyWizardSessionToken(guildId, body.sessionToken) || verifySwitchSessionToken(guildId, body.sessionToken);
  let freeUsesRemaining = 0;
  if (!hasValidSession) {
    const gate = await consumeAiGate(guildId);
    if (!gate.ok) return gate;
    freeUsesRemaining = gate.freeUsesRemaining;
  }

  const transcript = sanitizeTranscript(body.transcript);
  if (body.answer?.trim()) {
    transcript.push({ role: "user", content: body.answer.trim() });
  }
  const questionsAsked = transcript.filter((turn) => turn.role === "assistant").length;

  const messages: ChatTurn[] = [
    {
      role: "system",
      content:
        definition.buildSystemPrompt(ctx, questionsAsked) +
        (importFrom ? buildImportDirective(importFrom.source, importFrom.category) : ""),
    },
    ...transcript,
  ];

  const baseSchema = definition.buildResultSchema(ctx);
  const raw = await generateStructured({
    messages,
    schemaName: `ai_wizard_${wizardId}`,
    schema: importFrom ? withMoreToImport(baseSchema) : baseSchema,
    maxTokens: Math.max(definition.maxTokens ?? 1600, importFrom ? 3000 : 0),
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
      ...(importFrom ? { moreToImport: (turn as { more_to_import?: boolean }).more_to_import === true } : {}),
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

// ---------------------------------------------------------------------------------------------
// Switch: reading MEE6 / Dyno dashboard screenshots
// ---------------------------------------------------------------------------------------------

const MAX_IMAGE_CHARS = 6_000_000;
const SWITCH_READS_PER_WINDOW = 40;
const SWITCH_READ_WINDOW_MS = 6 * 60 * 60_000;
const switchReads = new Map<string, number[]>();

function isImageDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_CHARS &&
    /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
  );
}

export type SwitchReadResponse =
  | {
      ok: true;
      looksRight: boolean;
      notes: string;
      problem: string | null;
      sessionToken: string;
      freeUsesRemaining: number;
    }
  | { ok: false; error: string; status: number; freeUsesRemaining: number };

/**
 * Reads 1 to 4 screenshots of one MEE6/Dyno dashboard page into setup notes. The first read of a
 * Switch pays the Autopilot gate once and hands back a 6-hour switch token that every later read and
 * import wizard in the same Switch reuses for free.
 */
export async function readSwitchPage(
  guild: Guild,
  guildId: string,
  body: { source?: unknown; category?: unknown; images?: unknown; sessionToken?: string },
): Promise<SwitchReadResponse> {
  if (!isSwitchSource(body.source)) {
    return { ok: false, error: "Pick MEE6 or Dyno first.", status: 400, freeUsesRemaining: 0 };
  }
  const category = typeof body.category === "string" ? body.category.trim().slice(0, 80) : "";
  if (!category) return { ok: false, error: "Missing the page being imported.", status: 400, freeUsesRemaining: 0 };
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0 || images.length > MAX_SWITCH_IMAGES || !images.every(isImageDataUrl)) {
    return {
      ok: false,
      error: `Add between 1 and ${MAX_SWITCH_IMAGES} PNG, JPG or WebP screenshots.`,
      status: 400,
      freeUsesRemaining: 0,
    };
  }

  const now = Date.now();
  const recent = (switchReads.get(guildId) ?? []).filter((at) => now - at < SWITCH_READ_WINDOW_MS);
  if (recent.length >= SWITCH_READS_PER_WINDOW) {
    return {
      ok: false,
      error: "That's a lot of screenshots for one server. Give it a little while and try again.",
      status: 429,
      freeUsesRemaining: 0,
    };
  }

  const hasValidSession = verifySwitchSessionToken(guildId, body.sessionToken);
  let freeUsesRemaining = 0;
  if (!hasValidSession) {
    const gate = await consumeAiGate(guildId);
    if (!gate.ok) return gate;
    freeUsesRemaining = gate.freeUsesRemaining;
  }
  recent.push(now);
  switchReads.set(guildId, recent);

  const result = await readSwitchScreenshots({ source: body.source, categoryName: category, images, ctx: resolveWizardContext(guild) });
  return {
    ok: true,
    ...result,
    sessionToken: hasValidSession ? body.sessionToken! : issueSwitchSessionToken(guildId),
    freeUsesRemaining,
  };
}
