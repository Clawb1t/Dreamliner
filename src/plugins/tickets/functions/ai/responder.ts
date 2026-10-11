import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type SendableChannels,
} from "discord.js";
import { configManager } from "../../../../config/manager.js";
import type { GuildConfig } from "../../../../config/schemas/guild.js";
import type { TicketAiConfig } from "../../../../config/schemas/ticketAi.js";
import { zTicketsConfig, type TicketCategory, type TicketsConfig } from "../../../../config/schemas/tickets.js";
import { generateStructured } from "../../../../core/ai/client.js";
import { baseEmbed, setEmbedAuthor } from "../../../../core/embeds.js";
import { getLogger } from "../../../../core/logger.js";
import { buildTicketAiLog } from "../../../../core/logging/format.js";
import { sendModerationLog } from "../../../../core/logging/send.js";
import { getPluginSettings, hasPermission } from "../../../../core/permissionRoles.js";
import { containerReply } from "../../../../core/responses.js";
import { renderTemplate } from "../../../../core/templates.js";
import { getTicket, type TicketRecord } from "../tickets.js";
import {
  AI_LABEL_MARKER,
  AI_MARKER,
  buildMemberContext,
  buildServerContext,
  readConversation,
  staffRoleIdsFor,
  visibleChannels,
  type ChannelRef,
} from "./context.js";
import { ticketAiButtonId } from "./ids.js";
import {
  buildDataMessage,
  buildSystemPrompt,
  decisionSchema,
  linkChannelMentions,
  parseDecision,
  sanitizeReply,
  stripGreeting,
} from "./prompt.js";
import { refundUsage, takeReply } from "./quota.js";
import { rankKnowledge } from "./retrieve.js";
import {
  activeKnowledge,
  bumpUsage,
  countAiReply,
  getTicketAiState,
  markKnowledgeUsed,
  setTicketAiMode,
  startTicketAiState,
  type TicketAiState,
} from "./store.js";
import { fetchGuildChannel } from "../../../../core/guildChannel.js";

const log = getLogger("tickets:ai");

export const AI_EMOJI = "<:icons_spark:1544417582986297466>";
const STAFF_EMOJI = "<:icons_supportteam:1544417745406398504>";
const SOLVED_EMOJI = "<:icons_Correct:1544417199798886530>";
/** Invisible marker in every AI reply's footer, so its replies are recognised even with labels off. */

/** The model for the responder: its own setting, so Autopilot's model can differ. */
export function ticketAiModel(): string {
  return process.env.OPENAI_TICKET_MODEL?.trim() || "gpt-4.1-mini";
}

export type TicketAiContext = {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  pluginConfig: TicketsConfig;
  ticket: TicketRecord;
  category: TicketCategory | undefined;
};

export function aiConfigOf(pluginConfig: TicketsConfig): TicketAiConfig {
  return pluginConfig.ai_responder;
}

/** Whether the AI Responder takes tickets in this category. */
export function aiHandlesCategory(config: TicketAiConfig, categoryId: string): boolean {
  if (!config.enabled) return false;
  return config.category_ids.length === 0 || config.category_ids.includes(categoryId);
}

export function findCategory(pluginConfig: TicketsConfig, ticket: TicketRecord): TicketCategory | undefined {
  return pluginConfig.panels.find((p) => p.id === ticket.panelId)?.categories.find((c) => c.id === ticket.categoryId);
}

/** Loads everything needed to act on a ticket, fresh (config can change while a ticket is open). */
export async function loadTicketAiContext(client: Client, guildId: string, ticketId: number): Promise<TicketAiContext | null> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;
  const ticket = await getTicket(guildId, ticketId);
  if (!ticket) return null;
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  const pluginConfig = zTicketsConfig.parse(getPluginSettings(guildConfig, "tickets"));
  return { client, guild, guildConfig, pluginConfig, ticket, category: findCategory(pluginConfig, ticket) };
}

async function ticketChannel(ctx: Pick<TicketAiContext, "client" | "ticket">): Promise<SendableChannels | null> {
  const channel = await fetchGuildChannel(ctx.client, ctx.ticket.guildId, ctx.ticket.threadId ?? ctx.ticket.channelId);
  return channel?.isSendable() ? channel : null;
}

function aiButtons(ticketId: number, opts: { solved: boolean }): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ticketAiButtonId("staff", ticketId))
      .setLabel("Talk to staff")
      .setEmoji(STAFF_EMOJI)
      .setStyle(ButtonStyle.Secondary),
  );
  if (opts.solved) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(ticketAiButtonId("solved", ticketId))
        .setLabel("This solved it")
        .setEmoji(SOLVED_EMOJI)
        .setStyle(ButtonStyle.Success),
    );
  }
  return row;
}

function aiFooter(config: TicketAiConfig): string {
  const name = config.persona.name.trim() || "Support Assistant";
  return config.replies.show_label ? `${AI_MARKER}${name} · ${AI_LABEL_MARKER}, it can make mistakes` : `${AI_MARKER}${name}`;
}

async function postAiMessage(ctx: TicketAiContext, text: string, withButtons: boolean): Promise<boolean> {
  const channel = await ticketChannel(ctx);
  if (!channel) return false;
  const config = aiConfigOf(ctx.pluginConfig);
  const container = setEmbedAuthor(baseEmbed(), config.persona.name.trim() || "Support Assistant", ctx.client, { emoji: AI_EMOJI })
    .setDescription(text)
    .setFooter({ text: aiFooter(config) });
  const rows = withButtons && config.replies.buttons ? [aiButtons(ctx.ticket.id, { solved: true })] : [];
  const sent = await channel.send(containerReply(container, false, rows)).catch((err) => {
    log.warn(`Couldn't post an AI reply in ticket #${ctx.ticket.number} (${ctx.guild.id}): ${err instanceof Error ? err.message : err}`);
    return null;
  });
  return Boolean(sent);
}

/**
 * Called right after a ticket opens (createTicketForMember). Takes the ticket when the AI handles
 * its category: answers straight away when the opener filled in a form, otherwise greets them and
 * waits for their first message (a greeting costs nothing against the daily limit).
 */
export async function startTicketAi(ctx: TicketAiContext, member: GuildMember): Promise<void> {
  const config = aiConfigOf(ctx.pluginConfig);
  if (!aiHandlesCategory(config, ctx.ticket.categoryId)) return;
  startTicketAiState(ctx.ticket.id, ctx.guild.id);

  const answered = ctx.ticket.formResponses.some((a) => a.answer.trim());
  if (answered) {
    await runAiTurn(ctx.client, ctx.guild.id, ctx.ticket.id);
    return;
  }
  const greeting = renderTemplate(config.persona.greeting, { user: member.user, member, guild: ctx.guild })
    .replaceAll("{assistant}", config.persona.name.trim() || "Support Assistant")
    .replaceAll("{category}", ctx.category?.label ?? "Support")
    .trim();
  if (greeting) await postAiMessage(ctx, greeting, false);
}

// --- Turn scheduling: one generation per ticket at a time, after the member stops typing ------

const DEBOUNCE_MS = 3500;
const pending = new Map<number, NodeJS.Timeout>();
const running = new Set<number>();
const rerun = new Set<number>();

/** Queues an AI reply to the member's latest message(s), batching a quick burst into one reply. */
export function scheduleAiTurn(client: Client, guildId: string, ticketId: number): void {
  const existing = pending.get(ticketId);
  if (existing) clearTimeout(existing);
  pending.set(
    ticketId,
    setTimeout(() => {
      pending.delete(ticketId);
      if (running.has(ticketId)) {
        rerun.add(ticketId);
        return;
      }
      void runAiTurnLocked(client, guildId, ticketId);
    }, DEBOUNCE_MS),
  );
}

async function runAiTurnLocked(client: Client, guildId: string, ticketId: number): Promise<void> {
  running.add(ticketId);
  try {
    await runAiTurn(client, guildId, ticketId);
  } catch (err) {
    log.error(`AI turn failed for ticket ${ticketId} in ${guildId}:`, err);
  } finally {
    running.delete(ticketId);
    if (rerun.delete(ticketId)) void runAiTurnLocked(client, guildId, ticketId);
  }
}

/** One AI step in a ticket: reply, or hand it to staff. Does nothing unless the AI is in charge. */
export async function runAiTurn(client: Client, guildId: string, ticketId: number): Promise<void> {
  const ctx = await loadTicketAiContext(client, guildId, ticketId);
  if (!ctx || ctx.ticket.status !== "open") return;
  const config = aiConfigOf(ctx.pluginConfig);
  const state = getTicketAiState(ticketId);
  if (!state || state.mode !== "ai") return;
  if (!config.enabled) {
    await escalateTicket(ctx, { reason: "The AI Responder was turned off" });
    return;
  }
  if (state.aiReplies >= config.replies.max_per_ticket) {
    await escalateTicket(ctx, { reason: `Reached the limit of ${config.replies.max_per_ticket} AI replies for one ticket` });
    return;
  }
  if (!(await takeReply(guildId))) {
    await escalateTicket(ctx, { reason: "The server used all of today's AI replies" });
    return;
  }

  const channel = await ticketChannel(ctx);
  if (!channel) {
    refundUsage(guildId, "replies");
    return;
  }
  await channel.sendTyping().catch(() => null);

  let decision;
  let sources: string[] = [];
  let channels: ChannelRef[] = [];
  let continuing = false;
  try {
    const staffRoles = staffRoleIdsFor(ctx.category, ctx.pluginConfig);
    const conversation = await readConversation(channel, client, ctx.ticket.openerId, staffRoles);
    continuing = conversation.some((turn) => turn.speaker !== "member");
    const member = await ctx.guild.members.fetch(ctx.ticket.openerId).catch(() => null);
    channels = visibleChannels(ctx.guild, member, ctx.pluginConfig);
    const server = config.context.server_info
      ? buildServerContext(ctx.guild, ctx.guildConfig, ctx.pluginConfig, channels)
      : `Server: ${ctx.guild.name}`;
    const memberText = await buildMemberContext(ctx.guild, member, ctx.ticket.openerId, config, ctx.ticket.id);
    const query = [
      ...ctx.ticket.formResponses.map((a) => `${a.label} ${a.answer}`),
      ...conversation.filter((t) => t.speaker === "member").slice(-6).map((t) => t.text),
    ].join("\n");
    const knowledge = rankKnowledge(activeKnowledge(guildId), query);
    sources = [server, ...knowledge.map((k) => `${k.entry.title} ${k.entry.content}`)];

    const raw = await generateStructured({
      model: ticketAiModel(),
      schemaName: "ticket_ai_decision",
      schema: decisionSchema(),
      maxTokens: 900,
      messages: [
        { role: "system", content: buildSystemPrompt(config, ctx.guild.name) },
        {
          role: "user",
          content: buildDataMessage({
            server,
            member: memberText,
            category: ctx.category?.label ?? "Support",
            formAnswers: ctx.ticket.formResponses,
            knowledge,
            conversation,
          }),
        },
      ],
    });
    decision = parseDecision(raw, new Set(knowledge.map((k) => k.entry.id)));
  } catch (err) {
    refundUsage(guildId, "replies");
    log.error(`AI Responder call failed for ticket #${ctx.ticket.number} (${guildId}):`, err);
    await escalateTicket(ctx, { reason: "The AI assistant couldn't answer right now" });
    return;
  }

  // The ticket may have been taken over (or closed) while the model was thinking.
  const fresh = getTicketAiState(ticketId);
  if (!fresh || fresh.mode !== "ai") {
    refundUsage(guildId, "replies");
    return;
  }

  const sanitized = sanitizeReply(decision.reply, config.replies.max_length, sources);
  const reply = linkChannelMentions(continuing ? stripGreeting(sanitized) : sanitized, channels, (id) => ctx.guild.channels.cache.has(id));
  const lowConfidence = config.escalation.on_low_confidence && decision.confidence === "low";
  if (decision.action === "escalate" || lowConfidence || !reply) {
    await escalateTicket(ctx, {
      reason: decision.action === "escalate" ? "The AI decided staff should handle this" : "The AI wasn't confident in its answer",
      memberLine: decision.action === "escalate" ? reply : "",
      staffSummary: decision.staff_summary,
    });
    return;
  }

  if (await postAiMessage(ctx, reply, true)) {
    countAiReply(ticketId);
    markKnowledgeUsed(guildId, decision.knowledge_ids);
  } else {
    refundUsage(guildId, "replies");
  }
}

// --- Handing over -----------------------------------------------------------------------------

/**
 * Hands a ticket from the AI to staff: posts the hand-off (pinging the category's ping roles, or
 * its support roles when it has none, which were held back while the AI was handling it), logs it
 * and starts the staff escalation clock. Only happens once per ticket.
 */
export async function escalateTicket(
  ctx: TicketAiContext,
  options: { reason: string; memberLine?: string; staffSummary?: string; actorId?: string },
): Promise<TicketAiState | null> {
  const state = setTicketAiMode(ctx.ticket.id, "escalated", { from: ["ai"], reason: options.reason, changedBy: options.actorId ?? null });
  if (!state) return null;
  bumpUsage(ctx.guild.id, "escalations");

  const config = aiConfigOf(ctx.pluginConfig);
  const channel = await ticketChannel(ctx);
  if (channel) {
    const pingRoles = ctx.category?.ping_role_ids.filter(Boolean).length
      ? ctx.category.ping_role_ids.filter(Boolean)
      : staffRoleIdsFor(ctx.category, ctx.pluginConfig);
    const lines = [options.memberLine?.trim(), config.escalation.message.trim()].filter(Boolean) as string[];
    const container = setEmbedAuthor(baseEmbed(), "Handed to staff", ctx.client, { emoji: STAFF_EMOJI })
      .setDescription(lines.join("\n\n") || "A member of staff will be with you shortly.");
    if (options.staffSummary?.trim()) container.addFields({ name: "Summary for staff", value: options.staffSummary.trim().slice(0, 1000) });
    container.setFooter({ text: `${AI_MARKER}Reason: ${options.reason}` });
    await channel.send(containerReply(container)).catch(() => null);
    // Staff weren't pinged when the AI took the ticket; this is the ping.
    if (pingRoles.length) {
      await channel
        .send({ content: pingRoles.map((id) => `<@&${id}>`).join(" "), allowedMentions: { roles: pingRoles } })
        .catch(() => null);
    }
  }

  await sendModerationLog(
    ctx.client,
    ctx.guildConfig,
    buildTicketAiLog({
      title: `Ticket #${ctx.ticket.number} Handed to Staff by AI`,
      user: { id: ctx.ticket.openerId },
      channel: { id: ctx.ticket.channelId },
      lines: [`Reason: **${options.reason}**`, options.staffSummary ? `Summary: ${options.staffSummary}` : ""],
      emojiCategory: "action",
    }),
    {
      guildId: ctx.guild.id,
      eventType: "ticket_ai_escalate",
      actorId: options.actorId ?? ctx.ticket.openerId,
      channelId: ctx.ticket.channelId,
      caseLogOverride: ctx.pluginConfig.log_channel_id,
    },
  ).catch(() => null);
  return state;
}

/** /ticket ai stop: staff take over; the AI stays quiet in this ticket. */
export function stopTicketAi(ticket: TicketRecord, actorId: string): TicketAiState | null {
  return setTicketAiMode(ticket.id, "staff", { from: ["ai", "escalated"], reason: "Stopped by staff", changedBy: actorId });
}

/** /ticket ai resume: the AI takes the ticket back (with a fresh reply allowance). */
export async function resumeTicketAi(ctx: TicketAiContext, actorId: string): Promise<TicketAiState | null> {
  if (!getTicketAiState(ctx.ticket.id)) startTicketAiState(ctx.ticket.id, ctx.guild.id);
  const state = setTicketAiMode(ctx.ticket.id, "ai", { reason: "Resumed by staff", changedBy: actorId, resetReplies: true });
  if (state) {
    const name = aiConfigOf(ctx.pluginConfig).persona.name.trim() || "Support Assistant";
    await postAiMessage(ctx, `${name} is back on this ticket. Reply here and I'll pick it up from where things are.`, false);
  }
  return state;
}

// --- Messages and buttons ----------------------------------------------------------------------

/** From the tickets MessageCreate handler, for every human message in an open ticket. */
export function onTicketMessage(client: Client, ticket: TicketRecord, authorId: string, isStaff: boolean): void {
  const state = getTicketAiState(ticket.id);
  if (!state || state.mode !== "ai") return;
  if (isStaff && authorId !== ticket.openerId) {
    // A staff member answered: they're handling it now, and the AI steps back.
    setTicketAiMode(ticket.id, "staff", { from: ["ai"], reason: "A staff member replied", changedBy: authorId });
    return;
  }
  scheduleAiTurn(client, ticket.guildId, ticket.id);
}

/** "Talk to staff" and "This solved it" on AI replies. */
export async function handleTicketAiButton(
  interaction: ButtonInteraction,
  action: "staff" | "solved",
  ticketId: number,
  isStaff: (ctx: TicketAiContext, member: GuildMember) => boolean,
  closeTicket: (ctx: TicketAiContext, actorId: string, reason: string) => Promise<void>,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return;
  const ctx = await loadTicketAiContext(interaction.client, interaction.guild.id, ticketId);
  if (!ctx || ctx.ticket.status !== "open") {
    await interaction.reply({ content: "This ticket is already closed.", ephemeral: true }).catch(() => null);
    return;
  }
  const member = interaction.member as GuildMember;
  const allowed = interaction.user.id === ctx.ticket.openerId || isStaff(ctx, member);
  if (!allowed) {
    await interaction.reply({ content: "Only the person who opened this ticket can use these buttons.", ephemeral: true }).catch(() => null);
    return;
  }
  const config = aiConfigOf(ctx.pluginConfig);

  if (action === "staff") {
    await interaction.deferUpdate().catch(() => null);
    const state = await escalateTicket(ctx, { reason: "The member asked for staff", actorId: interaction.user.id });
    if (!state) await interaction.followUp({ content: "Staff have already been asked to help with this ticket.", ephemeral: true }).catch(() => null);
    return;
  }

  // Solved.
  await interaction.deferUpdate().catch(() => null);
  const state = setTicketAiMode(ctx.ticket.id, "staff", { from: ["ai"], reason: "Solved by the AI assistant", changedBy: interaction.user.id });
  if (state) bumpUsage(ctx.guild.id, "resolved");
  await sendModerationLog(
    ctx.client,
    ctx.guildConfig,
    buildTicketAiLog({
      title: `Ticket #${ctx.ticket.number} Solved by AI`,
      user: { id: ctx.ticket.openerId },
      channel: { id: ctx.ticket.channelId },
      lines: [`AI replies: **${state?.aiReplies ?? 0}**`],
      emojiCategory: "create",
    }),
    {
      guildId: ctx.guild.id,
      eventType: "ticket_ai_resolved",
      actorId: interaction.user.id,
      channelId: ctx.ticket.channelId,
      caseLogOverride: ctx.pluginConfig.log_channel_id,
    },
  ).catch(() => null);
  // Closing follows the category's own rule: when only staff may close, the opener's click just
  // marks it solved and leaves closing to staff.
  const clickerIsStaff = isStaff(ctx, member);
  const clickerIsOpener = interaction.user.id === ctx.ticket.openerId;
  const closePermission = ctx.category?.close_permission ?? "either";
  const mayClose =
    clickerIsStaff ||
    (clickerIsOpener && closePermission !== "staff" && (await hasPermission(ctx.guild.id, "tickets", "can_close", member, ctx.guildConfig)));
  if (config.replies.close_on_solved && mayClose) {
    await closeTicket(ctx, interaction.user.id, "Solved by the AI assistant");
  } else {
    const channel = await ticketChannel(ctx);
    await channel?.send({ content: `${SOLVED_EMOJI} Glad that's sorted! Staff can close this ticket whenever they're ready.`, allowedMentions: { parse: [] } }).catch(() => null);
  }
}
