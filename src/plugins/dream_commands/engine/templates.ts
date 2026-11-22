/**
 * Starter commands for the dashboard's Templates gallery. Each is a full program that passes
 * validateProgram (see templates test). Templates never contain ids: roles and channels are
 * picked after opening, or come from options.
 */
import { emptyMessageSpec } from "./fields.js";
import { EMPTY_ACCESS } from "./validate.js";
import { PROGRAM_VERSION, type CommandOption, type CommandProgram, type MessageSpec, type Step } from "./types.js";

export type Template = { id: string; name: string; description: string; icon: string; category: string; commandName: string; program: CommandProgram };

function text(content: string, extra: Partial<MessageSpec> = {}): MessageSpec {
  return { ...emptyMessageSpec(content), ...extra };
}

function embed(title: string, description: string, extra: Partial<MessageSpec["embed"]> = {}): MessageSpec {
  const m = emptyMessageSpec();
  m.format = "embed";
  m.embed = { ...m.embed, title, description, ...extra };
  return m;
}

function program(description: string, steps: Step[], opts: Partial<CommandProgram> = {}): CommandProgram {
  return {
    version: PROGRAM_VERSION,
    description,
    ephemeral: false,
    options: [],
    access: { ...EMPTY_ACCESS },
    cooldowns: { user: 0, channel: 0, global: 0 },
    limits: { perUserDaily: 0, guildDaily: 0 },
    steps,
    ...opts,
  };
}

const userOption = (name: string, description: string, required = true): CommandOption => ({ name, description, type: "member", required });
const textOption = (name: string, description: string, required = true, extra: Partial<CommandOption> = {}): CommandOption => ({ name, description, type: "text", required, ...extra });

export const TEMPLATES: Template[] = [
  {
    id: "member_role",
    name: "Give me the Member role",
    description: "Members toggle a role on themselves. Pick the role after opening.",
    icon: "role_toggle",
    category: "Roles",
    commandName: "member",
    program: program(
      "Get or remove the Member role",
      [
        { id: "step1", type: "toggle_role", config: { role: "", target: "{user.id}" } },
        {
          id: "step2",
          type: "if",
          config: {
            branches: [{ match: "all", conditions: [{ type: "compare", left: "{step1.added}", op: "eq", right: "true", caseSensitive: false }], steps: [{ id: "step3", type: "reply", config: { ephemeral: "yes", message: text("You have the role now. Run /member again to remove it.") } }] }],
            else: [{ id: "step4", type: "reply", config: { ephemeral: "yes", message: text("The role was removed.") } }],
          },
        },
      ],
      { ephemeral: true, cooldowns: { user: 5, channel: 0, global: 0 } },
    ),
  },
  {
    id: "private_channel",
    name: "Create a private channel for me",
    description: "Makes a private text channel only the runner (and roles you pick) can see, then links it.",
    icon: "channel_add",
    category: "Channels",
    commandName: "room",
    program: program(
      "Create your own private channel",
      [
        { id: "step1", type: "create_channel", config: { name: "{user.name}-room", kind: "text", parent: "", topic: "Private room for {user.display_name}", slowmode: 0, nsfw: false, private: true, allowRunner: true, allowRoles: [] } },
        { id: "step2", type: "reply", config: { ephemeral: "yes", message: text("Your private channel is ready: {step1.channel}") } },
      ],
      { ephemeral: true, cooldowns: { user: 3600, channel: 0, global: 0 }, limits: { perUserDaily: 1, guildDaily: 20 } },
    ),
  },
  {
    id: "random_cat",
    name: "Random cat",
    description: "Replies with a random cat picture from the Images plugin.",
    icon: "image",
    category: "Fun",
    commandName: "cat",
    program: program(
      "Get a random cat picture",
      [
        { id: "step1", type: "image_random", config: { source: "cat" } },
        { id: "step2", type: "reply", config: { ephemeral: "default", message: embed("Here's a cat", "", { imageUrl: "{step1.url}", color: 0xf59e0b, footerText: "Requested by {user.display_name}" }) } },
      ],
      { cooldowns: { user: 3, channel: 0, global: 0 } },
    ),
  },
  {
    id: "roll_die",
    name: "Roll a die",
    description: "Rolls a die with as many sides as they like (6 by default).",
    icon: "dice",
    category: "Fun",
    commandName: "roll",
    program: program(
      "Roll a die",
      [
        { id: "step1", type: "set_variable", config: { name: "sides", value: "{option.sides|6}", valueType: "number" } },
        { id: "step2", type: "math", config: { operation: "random", a: "1", b: "{var.sides}", name: "" } },
        { id: "step3", type: "reply", config: { ephemeral: "default", message: text("{user.mention} rolled a **{step2.result}** (1 to {var.sides})") } },
      ],
      { options: [{ name: "sides", description: "How many sides (default 6)", type: "integer", required: false, min: 2, max: 1000 }] },
    ),
  },
  {
    id: "eight_ball",
    name: "Magic 8 ball",
    description: "Answers any question with a random 8 ball reply.",
    icon: "random",
    category: "Fun",
    commandName: "8ball",
    program: program(
      "Ask the magic 8 ball",
      [
        { id: "step1", type: "random_item", config: { items: ["It is certain.", "Without a doubt.", "Yes, definitely.", "Most likely.", "Ask again later.", "Better not tell you now.", "Don't count on it.", "My sources say no.", "Very doubtful."] } },
        { id: "step2", type: "reply", config: { ephemeral: "default", message: embed("The magic 8 ball", "**Q:** {option.question}\n**A:** {step1.item}", { color: 0x7c3aed }) } },
      ],
      { options: [textOption("question", "What do you want to ask?", true, { maxLength: 200 })] },
    ),
  },
  {
    id: "report_user",
    name: "Report a user",
    description: "A form asks what happened, then the report goes to a staff channel you pick.",
    icon: "form",
    category: "Moderation",
    commandName: "report",
    program: program(
      "Report a member to the staff team",
      [
        {
          id: "step1",
          type: "form",
          config: {
            title: "Report {option.user}",
            inputs: [
              { id: "what", label: "What happened?", style: "paragraph", required: true, placeholder: "Describe what they did", minLength: 10, maxLength: 1000 },
              { id: "link", label: "Message link (optional)", style: "short", required: false, placeholder: "https://discord.com/channels/...", minLength: null, maxLength: 200 },
            ],
          },
        },
        { id: "step2", type: "send_message", config: { channel: "", message: embed("New report", "**Reported:** {option.user.mention}\n**By:** {user.mention}\n**In:** {channel}\n\n{form.what}\n\n{form.link}", { color: 0xef4444, timestamp: true }) } },
        { id: "step3", type: "reply", config: { ephemeral: "yes", message: text("Thanks, your report was sent to the staff team.") } },
      ],
      { ephemeral: true, options: [userOption("user", "Who are you reporting?")], cooldowns: { user: 120, channel: 0, global: 0 } },
    ),
  },
  {
    id: "lock_channel",
    name: "Lock this channel",
    description: "Staff lock the current channel so @everyone can't send messages.",
    icon: "lock",
    category: "Moderation",
    commandName: "lockdown",
    program: program(
      "Lock this channel",
      [
        { id: "step1", type: "lock_channel", config: { channel: "{channel.id}", role: "" } },
        { id: "step2", type: "reply", config: { ephemeral: "no", message: text("This channel is locked by {user.mention}.") } },
      ],
      { access: { ...EMPTY_ACCESS, permissions: ["ManageChannels"], visibility: ["ManageChannels"] } },
    ),
  },
  {
    id: "quick_giveaway",
    name: "Start a quick giveaway",
    description: "Staff start a giveaway in this channel with a prize and length.",
    icon: "gift",
    category: "Engagement",
    commandName: "quickgiveaway",
    program: program(
      "Start a quick giveaway here",
      [
        { id: "step1", type: "giveaway_start", config: { prize: "{option.prize}", channel: "{channel.id}", minutes: 60, winners: 1 } },
        { id: "step2", type: "reply", config: { ephemeral: "yes", message: text("Giveaway started for **{option.prize}**.") } },
      ],
      { ephemeral: true, options: [textOption("prize", "What are you giving away?", true, { maxLength: 200 })], access: { ...EMPTY_ACCESS, permissions: ["ManageGuild"], visibility: ["ManageGuild"] } },
    ),
  },
  {
    id: "server_info",
    name: "Server info card",
    description: "A tidy card with members, boosts, channels and roles.",
    icon: "server",
    category: "Info",
    commandName: "serverinfo",
    program: program("See this server's info", [
      { id: "step1", type: "server_info", config: {} },
      {
        id: "step2",
        type: "reply",
        config: {
          ephemeral: "default",
          message: embed("{server.name}", "Owned by {server.owner}", {
            thumbnailUrl: "{server.icon_url}",
            color: 0x5865f2,
            fields: [
              { name: "Members", value: "{step1.members}", inline: true },
              { name: "Boosts", value: "{step1.boosts} (level {step1.boost_tier})", inline: true },
              { name: "Channels", value: "{step1.channels}", inline: true },
              { name: "Roles", value: "{step1.roles}", inline: true },
              { name: "Created", value: "{step1.created_at}", inline: true },
            ],
          }),
        },
      },
    ]),
  },
  {
    id: "poll",
    name: "Poll",
    description: "Starts a Discord poll with a question and two answers.",
    icon: "poll",
    category: "Engagement",
    commandName: "poll",
    program: program(
      "Start a quick yes or no poll",
      [{ id: "step1", type: "poll", config: { question: "{option.question}", answers: ["Yes", "No"], hours: 24, multiple: false } }],
      { options: [textOption("question", "What's the question?", true, { maxLength: 300 })], cooldowns: { user: 60, channel: 0, global: 0 } },
    ),
  },
  {
    id: "random_winner",
    name: "Pick a random winner from a role",
    description: "Picks someone at random who has a role you choose.",
    icon: "shuffle",
    category: "Engagement",
    commandName: "pickwinner",
    program: program(
      "Pick a random member with a role",
      [
        { id: "step1", type: "random_member", config: { role: "{option.role.id}", excludeBots: true, excludeRunner: false } },
        { id: "step2", type: "reply", config: { ephemeral: "no", message: { ...text("The winner is {step1.member}! Congratulations."), pings: { runner: false, optionUsers: false, roles: [], everyone: false } } } },
      ],
      { options: [{ name: "role", description: "Pick from people with this role", type: "role", required: true }], access: { ...EMPTY_ACCESS, permissions: ["ManageGuild"], visibility: ["ManageGuild"] } },
    ),
  },
  {
    id: "welcome_kit",
    name: "Welcome kit",
    description: "Sends the runner a welcome DM and gives them a role you pick.",
    icon: "dm",
    category: "Roles",
    commandName: "welcome",
    program: program(
      "Get the welcome kit",
      [
        { id: "step1", type: "send_dm", config: { target: "{user.id}", failSilently: true, message: embed("Welcome to {server.name}", "Hi {user.display_name}, glad you're here. Read the rules and say hi!", { color: 0x22c55e }) } },
        { id: "step2", type: "add_role", config: { role: "", target: "{user.id}" } },
        { id: "step3", type: "reply", config: { ephemeral: "yes", message: text("Check your DMs, and enjoy your new role.") } },
      ],
      { ephemeral: true, limits: { perUserDaily: 1, guildDaily: 0 } },
    ),
  },
  {
    id: "coin_role",
    name: "Coin-gated role",
    description: "Charges server coins, then gives a role. Stops if they can't afford it.",
    icon: "coin",
    category: "Economy",
    commandName: "buyrole",
    program: program(
      "Buy a role with server coins",
      [
        { id: "step1", type: "economy_charge", config: { amount: 500, failMessage: "You need {amount} to buy this role." } },
        { id: "step2", type: "add_role", config: { role: "", target: "{user.id}" } },
        { id: "step3", type: "reply", config: { ephemeral: "yes", message: text("Done! Your balance is now {step1.formatted}.") } },
      ],
      { ephemeral: true, cooldowns: { user: 10, channel: 0, global: 0 } },
    ),
  },
  {
    id: "vote_buttons",
    name: "Quick vote with buttons",
    description: "Posts a question with Yes and No buttons; each press replies privately.",
    icon: "buttons",
    category: "Engagement",
    commandName: "quickvote",
    program: program(
      "Ask a quick yes or no question",
      [
        {
          id: "step1",
          type: "buttons",
          config: {
            message: text("**{option.question}**"),
            ephemeral: "no",
            who: "anyone",
            roleIds: [],
            singleUse: false,
            buttons: [
              { id: "yes", label: "Yes", style: "success", emoji: "", steps: [{ id: "step2", type: "reply", config: { ephemeral: "yes", message: text("You voted yes.") } }] },
              { id: "no", label: "No", style: "danger", emoji: "", steps: [{ id: "step3", type: "reply", config: { ephemeral: "yes", message: text("You voted no.") } }] },
            ],
          },
        },
      ],
      { options: [textOption("question", "What are you asking?", true, { maxLength: 200 })] },
    ),
  },
];
