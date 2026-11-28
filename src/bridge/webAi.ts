import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import { generateStructured, generateText, type ChatTurn } from "../core/ai/client.js";
import { consumeAiGate } from "../core/ai/gate.js";
import { getAiGateStatus, refundFreeAiUse } from "../core/ai/usage.js";
import {
  generateCharacterDraft,
  parseDraftRequest,
  type CharacterDraft,
} from "../plugins/characters/functions/draft.js";
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
import {
  DREAM_COMMAND_MAX_QUESTIONS,
  DREAM_COMMAND_MAX_TOKENS,
  DREAM_COMMAND_WIZARD_ID,
  allowedActionTypes,
  buildDreamCommandPrompt,
  buildDreamCommandSchema,
  checkDraft,
  repairMessage,
  type RawCommand,
} from "../core/ai/dreamCommand.js";
import { ACTOR_UNRESOLVED_MESSAGE, resolveActor } from "../core/actorPermissions.js";
import { configManager } from "../config/manager.js";
import { LIMITS } from "../plugins/dream_commands/engine/types.js";
import type { Issue } from "../plugins/dream_commands/engine/validate.js";

export async function getAiStatus(guildId: string) {
  return getAiGateStatus(guildId);
}

/** Gives back the free use a failed request charged (pass charged=false for Dreamliner One
 *  guilds, which weren't charged), and returns the guild's up-to-date remaining count. */
async function refundFailedUse(guildId: string, charged: boolean): Promise<number> {
  if (charged) await refundFreeAiUse(guildId).catch(() => null);
  return (await getAiGateStatus(guildId)).freeUsesRemaining;
}

function aiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.startsWith("Autopilot") ? error.message : fallback;
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
  let text: string;
  try {
    text = await generateText({
      system: definition.system,
      prompt: definition.buildPrompt(context),
      maxTokens: definition.maxTokens,
    });
  } catch (error) {
    return {
      ok: false,
      error: aiErrorMessage(error, "Autopilot couldn't write that right now. Please try again."),
      status: 502,
      freeUsesRemaining: await refundFailedUse(guildId, !gate.oneActive),
    };
  }

  return { ok: true, text, oneActive: gate.oneActive, freeUsesRemaining: gate.freeUsesRemaining };
}

/**
 * Characters' Autopilot: writes a first draft of a character from a description. Same OpenAI
 * client and shared free-use gate as every other Autopilot feature (one use per draft).
 */
export async function draftAiCharacter(
  guildId: string,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; draft: CharacterDraft; oneActive: boolean; freeUsesRemaining: number }
  | { ok: false; error: string; status: number; freeUsesRemaining: number; field?: string }
> {
  // Validate first, so a bad request never spends a use.
  const parsed = parseDraftRequest(body);
  if (!parsed.ok) {
    const status = await getAiGateStatus(guildId);
    return { ok: false, error: parsed.error, field: parsed.field, status: 400, freeUsesRemaining: status.freeUsesRemaining };
  }

  const gate = await consumeAiGate(guildId);
  if (!gate.ok) return gate;

  try {
    const draft = await generateCharacterDraft(parsed.value);
    return { ok: true, draft, oneActive: gate.oneActive, freeUsesRemaining: gate.freeUsesRemaining };
  } catch (error) {
    return {
      ok: false,
      error: aiErrorMessage(error, "Autopilot couldn't write that character right now. Please try again."),
      status: 502,
      freeUsesRemaining: await refundFailedUse(guildId, !gate.oneActive),
    };
  }
}

export function resolveWizardContext(guild: Guild): AiWizardContext {
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
  // A normal wizard token only covers the wizard it was paid for; a Switch token covers every
  // import wizard in that switch.
  const hasValidSession =
    verifyWizardSessionToken(guildId, wizardId, body.sessionToken) || verifySwitchSessionToken(guildId, body.sessionToken);
  let freeUsesRemaining: number;
  let charged = false;
  if (!hasValidSession) {
    const gate = await consumeAiGate(guildId);
    if (!gate.ok) return gate;
    freeUsesRemaining = gate.freeUsesRemaining;
    charged = !gate.oneActive;
  } else {
    freeUsesRemaining = (await getAiGateStatus(guildId)).freeUsesRemaining;
  }
  // Only the turn that paid is refunded; later turns of a paid session cost nothing anyway.
  const failedRemaining = async () => (charged ? refundFailedUse(guildId, true) : freeUsesRemaining);

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
  let raw: unknown;
  try {
    raw = await generateStructured({
      messages,
      schemaName: `ai_wizard_${wizardId}`,
      schema: importFrom ? withMoreToImport(baseSchema) : baseSchema,
      maxTokens: Math.max(definition.maxTokens ?? 1600, importFrom ? 3000 : 0),
    });
  } catch (error) {
    return {
      ok: false,
      error: aiErrorMessage(error, "Autopilot couldn't answer right now. Please try again."),
      status: 502,
      freeUsesRemaining: await failedRemaining(),
    };
  }
  const turn = raw as AiWizardTurn & { question?: string | null; summary?: string | null; config?: unknown };

  // A Switch import that had to pay (no valid switch token) hands back a switch token, so the
  // rest of that switch's reads and import wizards stay covered by this one use.
  const sessionToken = hasValidSession
    ? body.sessionToken!
    : importFrom
      ? issueSwitchSessionToken(guildId)
      : issueWizardSessionToken(guildId, wizardId);

  if (turn.action === "ready") {
    const config = (turn as { config: Record<string, unknown> | null }).config;
    if (!config || typeof config !== "object") {
      return { ok: false, error: "Autopilot did not return a valid setup.", status: 502, freeUsesRemaining: await failedRemaining() };
    }
    const validationError = definition.validateConfig?.(config, ctx);
    if (validationError) {
      return { ok: false, error: validationError, status: 502, freeUsesRemaining: await failedRemaining() };
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
    return { ok: false, error: "Pick the bot you're switching from first.", status: 400, freeUsesRemaining: 0 };
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
  let freeUsesRemaining: number;
  let charged = false;
  if (!hasValidSession) {
    const gate = await consumeAiGate(guildId);
    if (!gate.ok) return gate;
    freeUsesRemaining = gate.freeUsesRemaining;
    charged = !gate.oneActive;
  } else {
    freeUsesRemaining = (await getAiGateStatus(guildId)).freeUsesRemaining;
  }
  recent.push(now);
  switchReads.set(guildId, recent);

  let result: Awaited<ReturnType<typeof readSwitchScreenshots>>;
  try {
    result = await readSwitchScreenshots({ source: body.source, categoryName: category, images, ctx: resolveWizardContext(guild) });
  } catch (error) {
    return {
      ok: false,
      error: aiErrorMessage(error, "Autopilot couldn't read those screenshots right now. Please try again."),
      status: 502,
      freeUsesRemaining: charged ? await refundFailedUse(guildId, true) : freeUsesRemaining,
    };
  }
  return {
    ok: true,
    ...result,
    sessionToken: hasValidSession ? body.sessionToken! : issueSwitchSessionToken(guildId),
    freeUsesRemaining,
  };
}

// ---------------------------------------------------------------------------------------------
// Custom Commands: building and refining a whole command
// ---------------------------------------------------------------------------------------------

/**
 * Session tokens whose generation was already delivered. A token covers one generation: the
 * clarifying questions before a draft are free, and the draft itself is the use. Asking for
 * changes afterwards ("make it ephemeral") is a new generation, so it pays again even if the
 * browser sends the old token back. In memory only: a restart just means the next turn pays.
 */
const spentCommandTokens = new Map<string, number>();

function markCommandTokenSpent(token: string | undefined): void {
  if (!token) return;
  const now = Date.now();
  spentCommandTokens.set(token, now + 31 * 60_000);
  if (spentCommandTokens.size > 2000) {
    for (const [key, until] of spentCommandTokens) if (until <= now) spentCommandTokens.delete(key);
  }
}

export type DreamCommandAutopilotResult =
  | {
      ok: true;
      action: "ask" | "ready";
      question: string | null;
      answerKind: AnswerKind | null;
      quickReplies: string[] | null;
      /** A ready draft: { name, program }. Never saved here; the dashboard loads it into the builder. */
      config: { name: string; program: unknown } | null;
      summary: string | null;
      sessionToken: string;
      freeUsesRemaining: number;
    }
  | { ok: false; error: string; status: number; freeUsesRemaining: number; issues?: Issue[]; code?: string };

type CurrentDraft = { name: string; program: Record<string, unknown> };

function parseCurrentDraft(raw: unknown): CurrentDraft | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return "invalid";
  const { name, program } = raw as { name?: unknown; program?: unknown };
  if (!program || typeof program !== "object" || Array.isArray(program)) return "invalid";
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(program), "utf8");
  } catch {
    return "invalid";
  }
  if (bytes > LIMITS.programBytes) return "invalid";
  return { name: typeof name === "string" ? name.trim().toLowerCase().slice(0, 32) : "", program: program as Record<string, unknown> };
}

type CommandTurn = {
  action?: string;
  question?: string | null;
  answerKind?: string;
  quickReplies?: unknown;
  summary?: string | null;
  config?: RawCommand | null;
};

/**
 * Autopilot for Custom Commands. Describe a command (or, with `current`, ask for a change to the
 * one open in the builder) and get back a complete program as a draft. Nothing is saved: the
 * dashboard loads the draft into the builder and the user saves it, which runs every check again.
 *
 * Every draft is checked exactly as saving would be (validator and limits, this guild's ids, and
 * the requesting member's own permissions); a failing draft gets one automatic repair turn, then
 * is refused with the problems listed. Steps the member couldn't save are never offered to the
 * model. Each generation costs one Autopilot use through consumeAiGate.
 */
export async function runDreamCommandAutopilot(
  guild: Guild,
  guildId: string,
  userId: string,
  body: { sessionToken?: unknown; transcript?: unknown; answer?: unknown; current?: unknown },
): Promise<DreamCommandAutopilotResult> {
  const status = async () => (await getAiGateStatus(guildId)).freeUsesRemaining;
  const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 4000) : "";
  const transcript = sanitizeTranscript(body.transcript);
  if (answer) transcript.push({ role: "user", content: answer });
  if (!transcript.some((turn) => turn.role === "user")) {
    return { ok: false, error: "Describe the command you'd like.", status: 400, freeUsesRemaining: await status() };
  }

  const current = parseCurrentDraft(body.current);
  if (current === "invalid") return { ok: false, error: "The command to refine couldn't be read.", status: 400, freeUsesRemaining: await status() };

  // Checks that need no AI come first, so a request that can't work never spends a use.
  const actor = await resolveActor(guild, userId);
  if (!actor) return { ok: false, error: ACTOR_UNRESOLVED_MESSAGE, status: 403, code: "actor_unresolved", freeUsesRemaining: await status() };

  const [{ commandCap, getReservedCommandNames, guildHasOne }, { listDreamCommands }] = await Promise.all([
    import("../plugins/dream_commands/functions/guildSlash.js"),
    import("../plugins/dream_commands/functions/store.js"),
  ]);
  const existing = await listDreamCommands(guildId);
  const keepName = current && current.name && existing.some((c) => c.name === current.name) ? current.name : null;
  if (!current) {
    const cap = commandCap(await guildHasOne(guildId));
    if (existing.length >= cap) {
      return {
        ok: false,
        error:
          cap < LIMITS.oneCommands
            ? `This server has ${cap} custom commands, the free limit. Delete one to make room, or Dreamliner One raises it to ${LIMITS.oneCommands}.`
            : `This server has ${cap} custom commands, the most Discord allows.`,
        status: 400,
        code: "cap",
        freeUsesRemaining: await status(),
      };
    }
  }

  const token = typeof body.sessionToken === "string" && body.sessionToken ? body.sessionToken : undefined;
  const hasValidSession = token !== undefined && !spentCommandTokens.has(token) && verifyWizardSessionToken(guildId, DREAM_COMMAND_WIZARD_ID, token);
  let freeUsesRemaining: number;
  let charged = false;
  if (!hasValidSession) {
    const gate = await consumeAiGate(guildId);
    if (!gate.ok) return gate;
    freeUsesRemaining = gate.freeUsesRemaining;
    charged = !gate.oneActive;
  } else {
    freeUsesRemaining = await status();
  }
  const failedRemaining = async () => (charged ? refundFailedUse(guildId, true) : freeUsesRemaining);
  const sessionToken = hasValidSession ? token : issueWizardSessionToken(guildId, DREAM_COMMAND_WIZARD_ID);

  const ctx = resolveWizardContext(guild);
  const guildConfig = (await configManager.getEffectiveConfig(guildId)) as unknown as { plugins: Record<string, { enabled?: boolean } | undefined> };
  const allowedTypes = allowedActionTypes(guildConfig, actor);
  const questionsAsked = Math.min(DREAM_COMMAND_MAX_QUESTIONS, transcript.filter((turn) => turn.role === "assistant").length);
  const taken = new Set(existing.map((c) => c.name).filter((name) => name !== keepName));
  const messages: ChatTurn[] = [
    {
      role: "system",
      content: buildDreamCommandPrompt({
        ctx,
        allowedTypes,
        questionsAsked,
        current: current ? { name: keepName ?? current.name, program: current.program } : null,
        takenNames: [...taken],
      }),
    },
    ...transcript,
  ];
  const schema = buildDreamCommandSchema(ctx, allowedTypes);
  const generate = async () =>
    (await generateStructured({ messages, schemaName: "ai_wizard_dream_command", schema, maxTokens: DREAM_COMMAND_MAX_TOKENS })) as CommandTurn;

  let turn: CommandTurn;
  try {
    turn = await generate();
  } catch (error) {
    return { ok: false, error: aiErrorMessage(error, "Autopilot couldn't answer right now. Please try again."), status: 502, freeUsesRemaining: await failedRemaining() };
  }

  if (turn.action !== "ready" && questionsAsked < DREAM_COMMAND_MAX_QUESTIONS) {
    const rawKind = turn.answerKind ?? "";
    const quickReplies = Array.isArray(turn.quickReplies)
      ? turn.quickReplies.filter((reply): reply is string => typeof reply === "string" && reply.trim().length > 0).slice(0, 4)
      : [];
    return {
      ok: true,
      action: "ask",
      question: turn.question?.trim() || "Can you tell me a little more about what it should do?",
      answerKind: (ANSWER_KINDS as readonly string[]).includes(rawKind) ? (rawKind as AnswerKind) : "text",
      quickReplies: quickReplies.length ? quickReplies : null,
      config: null,
      summary: null,
      sessionToken,
      freeUsesRemaining,
    };
  }

  const reserved = getReservedCommandNames();
  const check = (raw: RawCommand | null | undefined) =>
    raw && typeof raw === "object"
      ? checkDraft(guild, actor, raw, { taken, reserved, keepName, allowedTypes })
      : { ok: false as const, issues: [{ path: "", stepId: null, message: "Autopilot didn't return a command." }] as Issue[], missing: [] as string[] };

  let result = check(turn.config);
  if (!result.ok) {
    // One repair turn: show the model exactly what failed and ask for the whole command again.
    messages.push({ role: "assistant", content: JSON.stringify(turn) });
    messages.push({ role: "user", content: repairMessage(result.issues, result.missing) });
    try {
      turn = await generate();
      result = check(turn.action === "ready" ? turn.config : null);
    } catch (error) {
      return { ok: false, error: aiErrorMessage(error, "Autopilot couldn't finish that command. Please try again."), status: 502, freeUsesRemaining: await failedRemaining() };
    }
  }
  if (!result.ok) {
    const head = result.missing.length
      ? `That command would need ${result.missing.join(", ")}, which you don't have, so Autopilot can't build it for you.`
      : `Autopilot couldn't build a command that passes Dreamliner's checks (${result.issues[0]?.message ?? "unknown problem"}). Try describing it a little differently.`;
    return { ok: false, error: head, status: 422, code: "invalid_draft", issues: result.issues.slice(0, 20), freeUsesRemaining: await failedRemaining() };
  }

  markCommandTokenSpent(sessionToken);
  return {
    ok: true,
    action: "ready",
    question: null,
    answerKind: null,
    quickReplies: null,
    config: { name: result.name, program: result.program },
    summary: turn.summary?.trim() || "Your command is ready to review.",
    sessionToken: "",
    freeUsesRemaining,
  };
}
