import { z } from "zod";

/**
 * AI Responder: the first line of support in tickets. It answers a new ticket with what it knows
 * about the server (default context, the knowledge base, Autotrain facts and approved lessons from
 * staff), and hands the ticket to staff when it can't help, the member asks for a person, the topic
 * is sensitive, or the server's daily reply limit runs out. Stored under tickets.config.ai_responder.
 */

/** Daily AI replies per server (UTC day). */
export const TICKET_AI_FREE_DAILY_REPLIES = 20;
export const TICKET_AI_ONE_DAILY_REPLIES = 1000;
/** Background AI calls per day (Autotrain runs, learning from staff), separate from replies. */
export const TICKET_AI_FREE_DAILY_BACKGROUND = 15;
export const TICKET_AI_ONE_DAILY_BACKGROUND = 300;

export const TICKET_AI_TONES = ["friendly", "professional", "casual", "concise"] as const;
export type TicketAiTone = (typeof TICKET_AI_TONES)[number];

export const MAX_TICKET_AI_KNOWLEDGE = 500;
export const MAX_TICKET_AI_AUTOTRAIN_CHANNELS = 10;

export const zTicketAiConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Let the AI answer new tickets first."),
  category_ids: z
    .array(z.string())
    .max(50)
    .default([])
    .describe("Ticket categories the AI handles (by category id). Empty means every category."),
  persona: z
    .strictObject({
      name: z.string().max(40).default("Support Assistant").describe("What the AI calls itself."),
      tone: z.enum(TICKET_AI_TONES).default("friendly").describe("How it writes."),
      instructions: z
        .string()
        .max(3000)
        .default("")
        .describe("Extra instructions from the server, e.g. what to always mention or never promise."),
      greeting: z
        .string()
        .max(1000)
        .default("Hi {user}, I'm {assistant}, the AI assistant here. Tell me what you need help with and I'll do my best, or press **Talk to staff** any time.")
        .describe("Posted when a ticket opens without form answers. Supports {user}, {assistant}, {guild} and {category}."),
    })
    .default({}),
  context: z
    .strictObject({
      server_info: z.boolean().default(true).describe("Server name, description, channels, roles and ticket categories."),
      member_profile: z.boolean().default(true).describe("The member's join date, roles and account age."),
      member_tickets: z.boolean().default(true).describe("The member's recent tickets and how they ended."),
      member_cases: z.boolean().default(false).describe("The member's moderation history (counts and recent reasons)."),
    })
    .default({}),
  replies: z
    .strictObject({
      max_length: z.number().int().min(200).max(1800).default(1000).describe("Longest reply, in characters."),
      max_per_ticket: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(8)
        .describe("AI replies in one ticket before it hands over to staff."),
      show_label: z.boolean().default(true).describe("Mark AI replies as AI-written."),
      buttons: z.boolean().default(true).describe("Add Talk to staff and This solved it buttons to AI replies."),
      close_on_solved: z.boolean().default(true).describe("Close the ticket when the member says the AI solved it."),
    })
    .default({}),
  escalation: z
    .strictObject({
      sensitive_topics: z
        .boolean()
        .default(true)
        .describe("Always hand over bans, appeals, payments, refunds, account access, harassment and safety reports."),
      topics: z
        .array(z.string().max(100))
        .max(30)
        .default([])
        .describe("Extra topics the AI should always hand to staff."),
      on_low_confidence: z.boolean().default(true).describe("Hand over when it isn't sure of the answer, instead of guessing."),
      message: z
        .string()
        .max(1000)
        .default("I've passed this to the staff team, someone will be with you shortly.")
        .describe("Posted when the AI hands the ticket to staff."),
    })
    .default({}),
  learning: z
    .strictObject({
      from_staff: z.boolean().default(true).describe("Learn from how staff answer tickets."),
      auto_approve: z
        .boolean()
        .default(false)
        .describe("Use lessons from staff straight away instead of waiting for approval on the dashboard."),
    })
    .default({}),
  autotrain: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Regularly read recent messages in the chosen channels and keep useful facts."),
      channel_ids: z
        .array(z.string())
        .max(MAX_TICKET_AI_AUTOTRAIN_CHANNELS)
        .default([])
        .describe("Channels Autotrain reads (announcements, FAQ, rules, info channels work best)."),
      lookback_days: z.number().int().min(1).max(90).default(30).describe("How far back to read."),
      interval_hours: z.number().int().min(6).max(168).default(24).describe("How often to re-read."),
    })
    .default({}),
});

export type TicketAiConfig = z.infer<typeof zTicketAiConfig>;
