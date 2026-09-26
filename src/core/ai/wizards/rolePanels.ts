/**
 * Role Panels Autopilot wizard: builds one new panel per run, covering every setting zRolePanel
 * supports (reaction or button trigger, posting a new message or attaching to an existing one,
 * single or multiple picks, removal on unreact, message text, the full embed, and per-role emoji,
 * label and button color).
 */
import { parseMessageLink } from "../../messageLink.js";
import { resolveEmojiByName } from "../../emoji.js";
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  emojiList,
  entityList,
  idOrEmpty,
  idRef,
  nullable,
  obj,
  oneOf,
  persistEmbedSchema,
  progressInstruction,
  str,
  turnSchemaWithIds,
  validId,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { boolOrNull, isRow, sanitizePersistEmbed, strOrNull } from "./autoRuleKit.js";

const MAX_QUESTIONS = 6;
const ROLE_BUTTON_STYLES = ["primary", "secondary", "success", "danger"] as const;

export function rolePanelConfigSchema(): Record<string, unknown> {
  return obj({
    name: nullable(str()),
    enabled: nullable(bool()),
    trigger_type: oneOf(["reaction", "button"]),
    post_mode: oneOf(["bot", "existing"]),
    channel_id: idOrEmpty("text_channel"),
    existing_message_link: str(),
    selection_mode: nullable(oneOf(["multiple", "single"])),
    remove_on_unreact: nullable(bool()),
    content: nullable(str()),
    embed: nullable(persistEmbedSchema()),
    roles: {
      type: "array",
      items: obj({
        role_id: idRef("role"),
        emoji: str(),
        label: nullable(str()),
        style: nullable(oneOf(ROLE_BUTTON_STYLES)),
      }),
    },
  });
}

export const validateRolePanelConfig: NonNullable<AiWizardDefinition["validateConfig"]> = (config, ctx) => {
  const postMode = config.post_mode === "existing" ? "existing" : "bot";
  config.post_mode = postMode;
  const triggerType = config.trigger_type === "button" ? "button" : "reaction";
  config.trigger_type = triggerType;

  if (postMode === "bot") {
    const channelId = config.channel_id;
    if (typeof channelId !== "string" || !channelId || !validId(channelId, ctx, "text_channel")) {
      return "Autopilot didn't pick a real channel to post the panel in. Please try again.";
    }
    config.existing_message_link = "";
  } else {
    const link = typeof config.existing_message_link === "string" ? config.existing_message_link.trim() : "";
    const parsed = link ? parseMessageLink(link) : null;
    if (!parsed) {
      return "Attaching to an existing message needs a valid Discord message link. Please try again and paste the message link.";
    }
    config.existing_message_link = `https://discord.com/channels/${parsed.guildId}/${parsed.channelId}/${parsed.messageId}`;
    config.channel_id = validId(config.channel_id, ctx, "text_channel") && typeof config.channel_id === "string"
      ? config.channel_id
      : "";
  }

  const seen = new Set<string>();
  const roles: Record<string, unknown>[] = [];
  for (const entry of Array.isArray(config.roles) ? config.roles.filter(isRow) : []) {
    const roleId = entry.role_id;
    if (typeof roleId !== "string" || !roleId || !validId(roleId, ctx, "role") || seen.has(roleId)) continue;
    seen.add(roleId);
    const emoji = typeof entry.emoji === "string" ? resolveEmojiByName(entry.emoji, ctx.emojis).slice(0, 128) : "";
    if (triggerType === "reaction" && !emoji) {
      return "Autopilot's setup was inconsistent (reaction panels need an emoji for every role). Please try again.";
    }
    roles.push({
      role_id: roleId,
      emoji,
      label: strOrNull(entry.label, 80),
      style:
        typeof entry.style === "string" && (ROLE_BUTTON_STYLES as readonly string[]).includes(entry.style)
          ? entry.style
          : null,
    });
  }
  if (roles.length === 0) return "Autopilot didn't pick any real roles for the panel. Please try again.";
  if (roles.length > (triggerType === "reaction" ? 20 : 25)) {
    return "Autopilot picked too many roles for one panel. Please try again with fewer.";
  }
  config.roles = roles;

  config.name = strOrNull(config.name, 80);
  config.enabled = boolOrNull(config.enabled);
  config.selection_mode = config.selection_mode === "single" || config.selection_mode === "multiple" ? config.selection_mode : null;
  config.remove_on_unreact = boolOrNull(config.remove_on_unreact);
  config.content = typeof config.content === "string" ? config.content.slice(0, 2000) : null;
  config.embed = sanitizePersistEmbed(config.embed);
  return null;
};

export const rolePanelsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 3000,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(rolePanelConfigSchema(), ctx),
  validateConfig: validateRolePanelConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up one Role Panel: a message members use to give " +
    "themselves roles, like a self-serve \"roles\" channel. You are setting this up for the server " +
    `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field names, ` +
    "JSON, or config, ask like a helpful person would.\n\n" +
    "What a panel can do:\n" +
    "- trigger_type: members either react with an emoji (\"reaction\", up to 20 roles) or click a " +
    "button (\"button\", up to 25 roles).\n" +
    "- post_mode: \"bot\" means Dreamliner posts its own message in channel_id (with optional text " +
    "and a full embed). \"existing\" attaches the roles to a message that is already posted, for " +
    "example an old MEE6, Dyno, or Carl-bot reaction-role message, leaving its text untouched: put " +
    "the message link (https://discord.com/channels/...) in existing_message_link and set channel_id " +
    "to \"\". Discord only lets Dreamliner add buttons to its own messages, so for a message posted by " +
    "another bot or a person use reactions. If the user wants to reuse an existing message but hasn't " +
    "given its link, ask for it (in Discord: right-click the message, Copy Message Link).\n" +
    "- selection_mode: \"multiple\" lets members hold several roles from the panel, \"single\" " +
    "swaps their previous pick out when they choose a new one.\n" +
    "- remove_on_unreact (reaction panels): whether removing the reaction also removes the role " +
    "(default on).\n" +
    "- content: the message text (max 2000 characters), and embed: a full embed (title, " +
    "description, color, author, thumbnail, image, footer, timestamp, up to 25 fields; icon and " +
    "thumbnail sources are none, guild, bot, or url). Both are only used when post_mode is \"bot\". " +
    "When you write them, make them specific to this server and the roles offered. " +
    COLOR_RULE +
    "\n- Each role has an emoji (required for reactions, optional decoration on buttons), a label " +
    "(button text, max 80 characters, null to use the role's own name), and style, the button color " +
    "(primary blurple, secondary gray, success green, danger red; buttons only).\n" +
    "- name is a dashboard-only label for the panel, and enabled turns it on or off.\n\n" +
    "Find out which roles to offer, reactions or buttons, where it goes (a new message in a channel, " +
    "or an existing message), and single or multiple picks. Match every role the user describes " +
    "against the existing roles list below; never invent a role that isn't in it, and ask for " +
    "clarification if you can't find a good match. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting roles (pick role_id for each entry from these ids only; never pick a role that " +
    "sounds like a bot/managed role, e.g. named after a bot):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels (pick channel_id from these ids only):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    `This server's custom emoji: ${emojiList(ctx.emojis)}. If the user means one of these (even just ` +
    "by name), put its exact name with no colons in that role's emoji and Dreamliner will use the " +
    "real custom emoji. Otherwise use a literal Unicode emoji matching the role. Reaction panels need " +
    "a real emoji for every role, never leave one empty; button panels can use \"\" for no emoji.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the choices you made (leave " +
    "question null). roles always needs at least one real entry. A \"bot\" panel always needs a real " +
    "channel_id, an \"existing\" panel always needs existing_message_link.",
};
