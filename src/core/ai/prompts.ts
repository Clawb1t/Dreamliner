/** Server-side registry of AI copywriting tasks. Adding AI to a new dashboard page later is
 * just adding an entry here (plus a UI button that passes its task id), no new bridge route,
 * no new gate logic. Prompts stay server-side so the API key and prompt engineering never
 * reach the browser. */

const PLACEHOLDER_GUIDE =
  "Available placeholders (use at most 2-3, only where natural): {user} (mention), " +
  "{user_display} (display name), {user_name} (username), {guild}/{server} (server name), " +
  "{guild_member_count}/{member_count} (member count). Never invent other placeholders.";

const BASE_SYSTEM =
  "You write short, friendly copy for a Discord server's welcome bot (Dreamliner). " +
  "Match the tone of a warm, casual community, not corporate, not cringe. " +
  "Discord markdown (**bold**, *italic*) is fine. Do not use emoji unless the existing draft " +
  "already does. Never use em dashes; use a comma, period, or 'and' instead. Output ONLY the " +
  "message text, no quotes, no explanation, no markdown headers. " +
  PLACEHOLDER_GUIDE;

export type AiTaskContext = {
  guildName?: string;
  existingContent?: string;
  /** Free-form steering from the user, e.g. "make it funnier" or "shorter, more formal". */
  instructions?: string;
};

export type AiTask = {
  system: string;
  buildPrompt: (context: AiTaskContext) => string;
  maxTokens: number;
};

function draftLine(context: AiTaskContext): string {
  const draft = context.existingContent?.trim()
    ? `The user's current draft (improve or riff on it, don't just repeat it):\n"""\n${context.existingContent.trim()}\n"""`
    : "The user has no draft yet, write one from scratch.";
  const instructions = context.instructions?.trim();
  return instructions
    ? `${draft}\n\nThe user's instructions for how they want this written (follow these closely, ` +
        `they override the general tone guidance above where they conflict): "${instructions}"`
    : draft;
}

export const AI_TASKS: Record<string, AiTask> = {
  welcome_join_message: {
    system: BASE_SYSTEM,
    maxTokens: 150,
    buildPrompt: (context) =>
      `Write one short welcome message (1-2 sentences) posted in a channel when a new member ` +
      `joins${context.guildName ? ` the Discord server "${context.guildName}"` : ""}. ${draftLine(context)}`,
  },
  welcome_leave_message: {
    system: BASE_SYSTEM,
    maxTokens: 150,
    buildPrompt: (context) =>
      `Write one short message (1 sentence) posted in a channel when a member leaves` +
      `${context.guildName ? ` the Discord server "${context.guildName}"` : ""}. Keep it low-key, ` +
      `not sad or dramatic. ${draftLine(context)}`,
  },
  welcome_dm_message: {
    system: BASE_SYSTEM,
    maxTokens: 200,
    buildPrompt: (context) =>
      `Write one short direct message (2-3 sentences) sent privately to a new member right ` +
      `after they join${context.guildName ? ` the Discord server "${context.guildName}"` : ""}. ` +
      `Make it feel personal, not like a mass DM. ${draftLine(context)}`,
  },
  welcome_embed_description: {
    system: BASE_SYSTEM,
    maxTokens: 250,
    buildPrompt: (context) =>
      `Write the description text (2-4 sentences, short paragraphs or a couple of lines) for an ` +
      `embed shown to new members${context.guildName ? ` of the Discord server "${context.guildName}"` : ""}. ` +
      `${draftLine(context)}`,
  },
};

export function isKnownAiTask(task: string): task is keyof typeof AI_TASKS {
  return Object.prototype.hasOwnProperty.call(AI_TASKS, task);
}
