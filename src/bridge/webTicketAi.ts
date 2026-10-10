import type { Client, Guild } from "discord.js";
import { and, eq, gte, sql } from "drizzle-orm";
import { configManager } from "../config/manager.js";
import { zTicketAiConfig, type TicketAiConfig } from "../config/schemas/ticketAi.js";
import { zTicketsConfig } from "../config/schemas/tickets.js";
import { generateStructured } from "../core/ai/client.js";
import { getPluginSettings } from "../core/permissionRoles.js";
import { getDb } from "../db/client.js";
import { ticketAiState } from "../db/schema.js";
import { runAutotrain } from "../plugins/tickets/functions/ai/autotrain.js";
import { buildMemberContext, buildServerContext } from "../plugins/tickets/functions/ai/context.js";
import { buildDataMessage, buildSystemPrompt, decisionSchema, parseDecision, sanitizeReply } from "../plugins/tickets/functions/ai/prompt.js";
import { refundUsage, takeReply, usageSummary, type UsageSummary } from "../plugins/tickets/functions/ai/quota.js";
import { ticketAiModel } from "../plugins/tickets/functions/ai/responder.js";
import { rankKnowledge } from "../plugins/tickets/functions/ai/retrieve.js";
import {
  activeKnowledge,
  addKnowledge,
  deleteKnowledge,
  getAutotrainState,
  getKnowledge,
  knowledgeCounts,
  KnowledgeLimitError,
  listKnowledge,
  updateKnowledge,
  usageHistory,
  type AutotrainResult,
  type KnowledgeEntry,
  type KnowledgeKind,
  type KnowledgeStatus,
} from "../plugins/tickets/functions/ai/store.js";

/** The dashboard's AI Responder page (a sub-page of Tickets). Server managers only (checked by the caller). */

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export type WebKnowledge = {
  id: number;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  title: string;
  content: string;
  source: string | null;
  sourceLabel: string | null;
  createdBy: string | null;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toWeb(guild: Guild, entry: KnowledgeEntry): WebKnowledge {
  let sourceLabel: string | null = null;
  if (entry.source?.startsWith("ticket:")) sourceLabel = `Ticket #${entry.source.slice(7)}`;
  else if (entry.source) {
    const channel = guild.channels.cache.get(entry.source);
    sourceLabel = channel ? `#${channel.name}` : "A deleted channel";
  }
  return {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    title: entry.title,
    content: entry.content,
    source: entry.source,
    sourceLabel,
    createdBy: entry.createdBy,
    uses: entry.uses,
    lastUsedAt: iso(entry.lastUsedAt),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export type TicketAiOverview = {
  usage: UsageSummary;
  history: Array<{ day: string; replies: number; escalations: number; resolved: number }>;
  knowledge: ReturnType<typeof knowledgeCounts>;
  autotrain: { lastRunAt: string | null; lastResult: AutotrainResult | null };
  /** Tickets the AI took in the last 30 days, by where they ended up. */
  tickets: { total: number; handledByAi: number; escalated: number; staff: number };
  model: string;
};

export async function getTicketAiOverview(guild: Guild): Promise<TicketAiOverview> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = getDb()
    .select({ mode: ticketAiState.mode, reason: ticketAiState.reason, n: sql<number>`count(*)` })
    .from(ticketAiState)
    .where(and(eq(ticketAiState.guildId, guild.id), gte(ticketAiState.createdAt, since)))
    .groupBy(ticketAiState.mode, ticketAiState.reason)
    .all();
  const tickets = { total: 0, handledByAi: 0, escalated: 0, staff: 0 };
  for (const row of rows) {
    // Rows created only so a staff-handled ticket could be learned from don't count as AI tickets.
    if (row.mode === "staff" && row.reason === null) continue;
    tickets.total += row.n;
    if (row.mode === "escalated") tickets.escalated += row.n;
    else if (row.mode === "staff" && row.reason === "Solved by the AI assistant") tickets.handledByAi += row.n;
    else if (row.mode === "staff") tickets.staff += row.n;
    else tickets.handledByAi += row.n;
  }
  const autotrain = getAutotrainState(guild.id);
  return {
    usage: await usageSummary(guild.id),
    history: usageHistory(guild.id, 14).map(({ day, replies, escalations, resolved }) => ({ day, replies, escalations, resolved })),
    knowledge: knowledgeCounts(guild.id),
    autotrain: { lastRunAt: iso(autotrain.lastRunAt), lastResult: autotrain.lastResult },
    tickets,
    model: ticketAiModel(),
  };
}

const KINDS = new Set<KnowledgeKind>(["faq", "note", "autotrain", "learned"]);
const STATUSES = new Set<KnowledgeStatus>(["active", "pending", "rejected"]);

export function listWebKnowledge(guild: Guild, url: URL) {
  const kind = url.searchParams.get("kind") as KnowledgeKind | null;
  const status = url.searchParams.get("status") as KnowledgeStatus | null;
  const { rows, total } = listKnowledge(guild.id, {
    kind: kind && KINDS.has(kind) ? kind : null,
    status: status && STATUSES.has(status) ? status : null,
    q: url.searchParams.get("q")?.slice(0, 100) ?? "",
    limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50)),
    offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
  });
  return { entries: rows.map((row) => toWeb(guild, row)), total, counts: knowledgeCounts(guild.id) };
}

type WriteResult = { ok: true; entry: WebKnowledge } | { ok: false; error: string };

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createWebKnowledge(guild: Guild, userId: string, body: Record<string, unknown>): WriteResult {
  const kind = body.kind === "note" ? "note" : "faq";
  const title = text(body.title, 200);
  const content = text(body.content, 4000);
  if (title.length < 3) return { ok: false, error: kind === "faq" ? "Write the question." : "Give the note a title." };
  if (content.length < 3) return { ok: false, error: "Write the answer." };
  try {
    return { ok: true, entry: toWeb(guild, addKnowledge({ guildId: guild.id, kind, title, content, createdBy: userId })) };
  } catch (err) {
    if (err instanceof KnowledgeLimitError) return { ok: false, error: err.message };
    throw err;
  }
}

export function updateWebKnowledge(guild: Guild, id: number, body: Record<string, unknown>): WriteResult {
  const existing = getKnowledge(guild.id, id);
  if (!existing) return { ok: false, error: "That entry doesn't exist any more." };
  const patch: { title?: string; content?: string; status?: KnowledgeStatus } = {};
  if (body.title !== undefined) {
    patch.title = text(body.title, 200);
    if (patch.title.length < 3) return { ok: false, error: "The title is too short." };
  }
  if (body.content !== undefined) {
    patch.content = text(body.content, 4000);
    if (patch.content.length < 3) return { ok: false, error: "The answer is too short." };
  }
  if (typeof body.status === "string" && STATUSES.has(body.status as KnowledgeStatus)) patch.status = body.status as KnowledgeStatus;
  const updated = updateKnowledge(guild.id, id, patch);
  return updated ? { ok: true, entry: toWeb(guild, updated) } : { ok: false, error: "Couldn't save that entry." };
}

export function deleteWebKnowledge(guild: Guild, id: number): boolean {
  return deleteKnowledge(guild.id, id);
}

export async function runWebAutotrain(client: Client, guild: Guild): Promise<AutotrainResult> {
  return runAutotrain(client, guild.id);
}

export type TicketAiTestResult =
  | {
      ok: true;
      action: "reply" | "escalate";
      reply: string;
      staffSummary: string;
      confidence: "high" | "medium" | "low";
      knowledge: Array<{ id: number; title: string; kind: KnowledgeKind }>;
      usage: UsageSummary;
    }
  | { ok: false; error: string };

/**
 * The dashboard's test chat: what the AI would answer, with the settings on screen (saved or not)
 * and the real knowledge base, as if the signed-in admin opened a ticket. Uses one of today's replies.
 */
export async function testTicketAi(guild: Guild, userId: string, body: Record<string, unknown>): Promise<TicketAiTestResult> {
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m): m is { role: string; text: string } => Boolean(m) && typeof (m as { text?: unknown }).text === "string")
    .slice(-12)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "member", text: m.text.trim().slice(0, 1500) }))
    .filter((m) => m.text);
  if (!messages.length || messages[messages.length - 1]!.role !== "member") return { ok: false, error: "Write a message to test with." };

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const pluginConfig = zTicketsConfig.parse(getPluginSettings(guildConfig, "tickets"));
  const draft = zTicketAiConfig.safeParse(body.config);
  const config: TicketAiConfig = draft.success ? draft.data : pluginConfig.ai_responder;

  if (!(await takeReply(guild.id))) return { ok: false, error: "This server has used all of today's AI replies." };
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    const server = config.context.server_info ? buildServerContext(guild, guildConfig, pluginConfig) : `Server: ${guild.name}`;
    const memberText = await buildMemberContext(guild, member, userId, config, -1);
    const query = messages.filter((m) => m.role === "member").map((m) => m.text).join("\n");
    const knowledge = rankKnowledge(activeKnowledge(guild.id), query);
    const raw = await generateStructured({
      model: ticketAiModel(),
      schemaName: "ticket_ai_decision",
      schema: decisionSchema(),
      maxTokens: 900,
      messages: [
        { role: "system", content: buildSystemPrompt(config, guild.name) },
        {
          role: "user",
          content: buildDataMessage({
            server,
            member: memberText,
            category: "Support (dashboard test)",
            formAnswers: [],
            knowledge,
            conversation: messages.map((m) => ({
              speaker: m.role === "assistant" ? "assistant" : "member",
              name: member?.displayName ?? "Member",
              text: m.text,
            })),
          }),
        },
      ],
    });
    const decision = parseDecision(raw, new Set(knowledge.map((k) => k.entry.id)));
    const reply = sanitizeReply(decision.reply, config.replies.max_length, [server, ...knowledge.map((k) => `${k.entry.title} ${k.entry.content}`)]);
    const lowConfidence = config.escalation.on_low_confidence && decision.confidence === "low";
    return {
      ok: true,
      action: decision.action === "escalate" || lowConfidence || !reply ? "escalate" : "reply",
      reply,
      staffSummary: decision.staff_summary,
      confidence: decision.confidence,
      knowledge: knowledge
        .filter((k) => decision.knowledge_ids.includes(k.entry.id))
        .map((k) => ({ id: k.entry.id, title: k.entry.title, kind: k.entry.kind })),
      usage: await usageSummary(guild.id),
    };
  } catch (err) {
    refundUsage(guild.id, "replies");
    return { ok: false, error: err instanceof Error && /OPENAI_API_KEY/.test(err.message) ? "AI isn't configured on the bot." : "The AI couldn't answer right now. Try again." };
  }
}
