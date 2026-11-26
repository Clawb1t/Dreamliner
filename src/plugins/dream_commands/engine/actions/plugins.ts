/**
 * Dreamliner plugin steps. Each goes through the plugin's own functions and rules (enabled check,
 * blocks, cooldowns, limits). Economy steps only ever READ or SPEND server coins: custom commands
 * never create currency (no credit/mint step exists, see anti-mint test).
 */
import type { ActionDef } from "../action.js";
import { bool, channelTargetField, num, str, userTargetField } from "../action.js";
import { pluginEnabled } from "../../../../core/pluginCommand.js";
import { resolveEffectivePluginConfig } from "../../../../core/permissionRoles.js";
import { resolveMember, resolveTextChannel, spendApi, StepError, type RunCtx } from "../runtime.js";
import { interpolate } from "../vars.js";

function requirePlugin(ctx: RunCtx, plugin: string, label: string): void {
  if (!pluginEnabled(ctx.guildConfig, plugin)) throw new StepError(`The ${label} plugin is turned off in this server.`, "plugin_off");
}

const IMAGE_SOURCE_OPTIONS = [
  { value: "cat", label: "Cats" },
  { value: "dog", label: "Dogs" },
  { value: "fox", label: "Foxes" },
  { value: "duck", label: "Ducks" },
  { value: "capybara", label: "Capybaras" },
  { value: "bird", label: "Birds" },
  { value: "blahaj", label: "Blåhaj" },
  { value: "anime", label: "Anime" },
];

export const pluginActions: ActionDef[] = [
  {
    type: "image_random",
    category: "plugins",
    label: "Get a random image",
    description: "Fetch a random cat, dog, fox and more from the Images plugin. Use the link in a reply.",
    icon: "image",
    plugin: "images",
    pluginLabel: "Images",
    fields: [{ key: "source", label: "Image of", kind: "select", options: IMAGE_SOURCE_OPTIONS }],
    outputs: [
      { key: "url", label: "Image link" },
      { key: "credit", label: "Credit line" },
    ],
    defaults: { source: "cat" },
    summary: "Get a random {source} image",
    run: async (ctx, config) => {
      requirePlugin(ctx, "images", "Images");
      const { fetchImage } = await import("../../../images/functions/sources.js");
      const source = IMAGE_SOURCE_OPTIONS.some((o) => o.value === config.source) ? (config.source as "cat") : "cat";
      spendApi(ctx);
      const image = await fetchImage(source).catch(() => {
        throw new StepError("The image service didn't answer. Try again.");
      });
      return { outputs: { url: image.url, credit: image.credit }, trusted: ["url"] };
    },
  },
  {
    type: "giveaway_start",
    category: "plugins",
    label: "Start a giveaway",
    description: "Start a giveaway with the Giveaways plugin.",
    icon: "gift",
    plugin: "giveaways",
    pluginLabel: "Giveaways",
    fields: [
      { key: "prize", label: "Prize", kind: "text", required: true, maxLength: 200, variables: true },
      channelTargetField("channel", "Channel", ["text", "announcement"]),
      { key: "minutes", label: "Runs for (minutes)", kind: "number", integer: true, min: 1, max: 129600 },
      { key: "winners", label: "Winners", kind: "number", integer: true, min: 1, max: 50 },
    ],
    outputs: [{ key: "giveaway.id", label: "Giveaway ID" }],
    defaults: { prize: "", channel: "{channel.id}", minutes: 60, winners: 1 },
    summary: "Start a giveaway for {prize}",
    builderPerms: () => ["ManageGuild"],
    botPerms: () => ["SendMessages"],
    run: async (ctx, config) => {
      requirePlugin(ctx, "giveaways", "Giveaways");
      const channel = await resolveTextChannel(ctx, config.channel);
      const { createGiveawayFromInput } = await import("../../../giveaways/functions/create.js");
      const prize = interpolate(str(config, "prize"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 200);
      if (!prize) throw new StepError("The giveaway needs a prize.");
      spendApi(ctx, 2);
      const result = await createGiveawayFromInput(ctx.guild, ctx.builderId, {
        channelId: channel.id,
        prize,
        winnerCount: Math.min(50, Math.max(1, num(config, "winners", 1))),
        durationMinutes: Math.min(129600, Math.max(1, num(config, "minutes", 60))),
        hostId: ctx.runner.id,
      } as never);
      if ("error" in result) throw new StepError(result.error);
      return { outputs: { "giveaway.id": String(result.giveaway.id) } };
    },
  },
  {
    type: "quiz_post",
    category: "plugins",
    label: "Post a quiz",
    description: "Post a published quiz's panel in a channel.",
    icon: "quiz",
    plugin: "quizzes",
    pluginLabel: "Quizzes",
    fields: [{ key: "quiz", label: "Quiz", kind: "select", dynamic: true, required: true, options: [] }, channelTargetField("channel", "Channel", ["text", "announcement"])],
    outputs: [{ key: "url", label: "Panel link" }],
    defaults: { quiz: "", channel: "{channel.id}" },
    summary: "Post the quiz {quiz} in {channel}",
    builderPerms: () => ["ManageGuild"],
    run: async (ctx, config) => {
      requirePlugin(ctx, "quizzes", "Quizzes");
      const channel = await resolveTextChannel(ctx, config.channel);
      const store = await import("../../../quizzes/functions/store.js");
      const quiz = store.getQuiz(ctx.guild.id, Number(str(config, "quiz")));
      if (!quiz) throw new StepError("That quiz doesn't exist any more.");
      const { postPanel } = await import("../../../quizzes/functions/panel.js");
      spendApi(ctx, 2);
      const result = await postPanel(ctx.guild, quiz, channel.id, ctx.builderId);
      if ("error" in result) throw new StepError(result.error);
      return { outputs: { url: result.url }, trusted: ["url"] };
    },
  },
  {
    type: "suggestion_create",
    category: "plugins",
    label: "Make a suggestion",
    description: "Submit a suggestion for the person who ran it, with the Suggestions plugin's rules.",
    icon: "lightbulb",
    plugin: "suggestions",
    pluginLabel: "Suggestions",
    fields: [{ key: "content", label: "Suggestion text", kind: "textarea", required: true, maxLength: 2000, variables: true }, { key: "anonymous", label: "Anonymous", kind: "boolean" }],
    outputs: [{ key: "suggestion.number", label: "Suggestion number" }],
    defaults: { content: "{option.idea}", anonymous: false },
    summary: "Make a suggestion",
    run: async (ctx, config) => {
      requirePlugin(ctx, "suggestions", "Suggestions");
      const { zSuggestionsConfig } = await import("../../../../config/schemas/suggestions.js");
      const sstore = await import("../../../suggestions/functions/store.js");
      const cfg = zSuggestionsConfig.parse(await resolveEffectivePluginConfig(ctx.guild.id, "suggestions", ctx.runner, ctx.guildConfig));
      if (await sstore.isBlocked(ctx.guild.id, ctx.runner.id)) throw new StepError("You're blocked from making suggestions here.");
      const { checkFeedbackEligibility } = await import("../../../feedback/eligibility.js");
      const eligibility = await checkFeedbackEligibility({
        member: ctx.runner,
        channelId: ctx.channelId,
        config: {
          min_messages: cfg.min_messages,
          min_account_age: cfg.min_account_age,
          min_member_age: cfg.min_member_age,
          require_passport: cfg.require_passport,
          cooldown: cfg.cooldown,
          allowed_roles: cfg.allowed_suggest_roles,
          blocked_roles: cfg.blocked_suggest_roles,
          ignored_channels: cfg.ignored_channels,
          command_channels: cfg.command_channels,
        },
        lastActionAt: await sstore.getLastSuggestionAt(ctx.guild.id, ctx.runner.id),
      } as never);
      if (!eligibility.ok) throw new StepError(eligibility.message);
      if (cfg.max_open > 0 && (await sstore.countOpenApproved(ctx.guild.id, ctx.runner.id)) >= cfg.max_open) throw new StepError(`You already have ${cfg.max_open} open suggestions.`);
      const content = interpolate(str(config, "content"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim();
      if (content.length < cfg.min_length) throw new StepError(`Suggestions must be at least ${cfg.min_length} characters.`);
      if (content.length > cfg.max_length) throw new StepError(`Suggestions must be under ${cfg.max_length} characters.`);
      if (bool(config, "anonymous") && !cfg.anonymous) throw new StepError("Anonymous suggestions are turned off here.");
      const { submitSuggestion } = await import("../../../suggestions/functions/service.js");
      spendApi(ctx, 2);
      const result = await submitSuggestion({ client: ctx.client, guild: ctx.guild, author: ctx.runner, guildConfig: ctx.guildConfig, config: cfg, content, anonymous: bool(config, "anonymous") });
      if (result.error) throw new StepError(result.error);
      return { outputs: { "suggestion.number": result.suggestion.suggestionNumber } };
    },
  },
  {
    type: "ticket_open",
    category: "plugins",
    label: "Open a ticket",
    description: "Open a ticket for the person who ran it, with the Tickets plugin's rules.",
    icon: "ticket",
    plugin: "tickets",
    pluginLabel: "Tickets",
    fields: [{ key: "category", label: "Ticket type", kind: "select", dynamic: true, required: true, options: [] }],
    outputs: [
      { key: "channel", label: "Ticket channel mention" },
      { key: "channel.id", label: "Ticket channel ID" },
    ],
    defaults: { category: "" },
    summary: "Open a {category} ticket",
    builderPerms: () => ["ManageChannels"],
    run: async (ctx, config) => {
      requirePlugin(ctx, "tickets", "Tickets");
      const { zTicketsConfig } = await import("../../../../config/schemas/tickets.js");
      const cfg = zTicketsConfig.parse(await resolveEffectivePluginConfig(ctx.guild.id, "tickets", ctx.runner, ctx.guildConfig));
      const [panelId, categoryId] = str(config, "category").split(":");
      const panel = cfg.panels.find((p) => p.id === panelId);
      const category = panel?.categories.find((c) => c.id === categoryId);
      if (!panel || !category || !panel.enabled) throw new StepError("That ticket type doesn't exist or is turned off.");
      const { createTicketForMember } = await import("../../../tickets/functions/actions.js");
      spendApi(ctx, 4);
      const result = await createTicketForMember({ client: ctx.client, guild: ctx.guild, member: ctx.runner, panel, category, guildConfig: ctx.guildConfig, pluginConfig: cfg } as never);
      if ("error" in result) throw new StepError(result.error);
      const id = (result.ticket as { channelId: string }).channelId;
      return { outputs: { channel: `<#${id}>`, "channel.id": id }, trusted: ["channel", "channel.id"] };
    },
  },
  {
    type: "reminder_create",
    category: "plugins",
    label: "Set a reminder",
    description: "Remind the person who ran it later (by DM, or here if their DMs are closed).",
    icon: "bell",
    plugin: "reminders",
    pluginLabel: "Reminders",
    fields: [
      { key: "message", label: "Remind them of", kind: "text", required: true, maxLength: 500, variables: true },
      { key: "minutes", label: "In (minutes)", kind: "text", required: true, maxLength: 60, variables: true, help: "A number, or a variable like {option.minutes}." },
    ],
    outputs: [{ key: "at", label: "When (Discord timestamp)" }],
    defaults: { message: "{option.what}", minutes: "{option.minutes}" },
    summary: "Remind them: {message}",
    run: async (ctx, config) => {
      requirePlugin(ctx, "reminders", "Reminders");
      const minutes = Math.floor(Number(interpolate(str(config, "minutes"), ctx.vars, { mode: "raw", rng: ctx.rng })));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 525600) throw new StepError("Reminders can be 1 minute to 1 year away.");
      const store = await import("../../../reminders/functions/store.js");
      if ((await store.listReminders(ctx.guild.id, ctx.runner.id)).length >= 25) throw new StepError("You already have 25 reminders here. Cancel one first.");
      const message = interpolate(str(config, "message"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 500) || "Reminder";
      await store.createReminder({ guildId: ctx.guild.id, userId: ctx.runner.id, channelId: ctx.channelId, message, delayMinutes: minutes });
      return { outputs: { at: `<t:${Math.floor(Date.now() / 1000 + minutes * 60)}:R>` }, trusted: ["at"] };
    },
  },
  {
    type: "stats_fetch",
    category: "plugins",
    label: "Get message stats",
    description: "Someone's message count and rank in this server.",
    icon: "chart",
    plugin: "stats",
    pluginLabel: "Stats",
    fields: [userTargetField()],
    outputs: [
      { key: "messages", label: "Messages sent here" },
      { key: "rank", label: "Rank in this server" },
    ],
    defaults: { target: "{user.id}" },
    summary: "Get message stats for {target}",
    run: async (ctx, config) => {
      requirePlugin(ctx, "stats", "Stats");
      const member = await resolveMember(ctx, config.target);
      // Per-server numbers only (no cross-server data, so Ghost Mode doesn't apply).
      const { getUserMessageCount, getUserMessageRank } = await import("../../../stats/functions/queries.js");
      const messages = await getUserMessageCount(ctx.guild.id, member.id);
      const rank = await getUserMessageRank(ctx.guild.id, member.id, messages);
      return { outputs: { messages, rank } };
    },
  },
  {
    type: "economy_balance",
    category: "plugins",
    label: "Get coin balance",
    description: "Someone's balance of this server's currency.",
    icon: "coin",
    plugin: "economy",
    pluginLabel: "Economy",
    fields: [userTargetField()],
    outputs: [
      { key: "balance", label: "Balance (number)" },
      { key: "formatted", label: "Balance with currency" },
    ],
    defaults: { target: "{user.id}" },
    summary: "Get the coin balance of {target}",
    run: async (ctx, config) => {
      const { loadEconomyConfig } = await import("../../../economy/functions/config.js");
      const economy = await loadEconomyConfig(ctx.guild.id);
      if (!economy) throw new StepError("The Economy plugin is turned off in this server.", "plugin_off");
      const member = await resolveMember(ctx, config.target);
      const { getServerBalance } = await import("../../../economy/functions/money.js");
      const { formatServer } = await import("../../../economy/functions/format.js");
      const balance = getServerBalance(ctx.guild.id, member.id);
      return { outputs: { balance, formatted: formatServer(balance, economy.server) } };
    },
  },
  {
    type: "economy_charge",
    category: "plugins",
    label: "Charge coins",
    description: "Take server coins from the person who ran it. If they can't afford it, the command stops here. Coins are spent, never created.",
    icon: "coin",
    plugin: "economy",
    pluginLabel: "Economy",
    fields: [
      { key: "amount", label: "Coins", kind: "number", min: 0.01, max: 1_000_000, required: true },
      { key: "failMessage", label: "Message if they can't afford it", kind: "text", maxLength: 300, variables: true },
    ],
    outputs: [
      { key: "balance", label: "Balance after" },
      { key: "formatted", label: "Balance after, with currency" },
    ],
    defaults: { amount: 100, failMessage: "You need {amount} coins for this." },
    summary: "Charge {amount} coins",
    run: async (ctx, config) => {
      const { loadEconomyConfig } = await import("../../../economy/functions/config.js");
      const economy = await loadEconomyConfig(ctx.guild.id);
      if (!economy) throw new StepError("The Economy plugin is turned off in this server.", "plugin_off");
      const amount = Math.round(Math.min(1_000_000, Math.max(0.01, num(config, "amount", 1))) * 100) / 100;
      const { spendServer, InsufficientFundsError } = await import("../../../economy/functions/money.js");
      const { formatServer } = await import("../../../economy/functions/format.js");
      try {
        const balance = spendServer(ctx.guild.id, ctx.runner.id, amount);
        return { outputs: { balance, formatted: formatServer(balance, economy.server) } };
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          ctx.vars.values.set("amount", formatServer(amount, economy.server));
          const text = interpolate(str(config, "failMessage") || "You can't afford this.", ctx.vars, { mode: "message", rng: ctx.rng });
          throw new StepError(text.slice(0, 300) || "You can't afford this.", "insufficient_funds");
        }
        throw error;
      }
    },
  },
  {
    type: "birthday_get",
    category: "plugins",
    label: "Get a birthday",
    description: "Someone's birthday from the Birthdays plugin.",
    icon: "cake",
    plugin: "birthdays",
    pluginLabel: "Birthdays",
    fields: [userTargetField()],
    outputs: [
      { key: "has", label: "Has one set (true or false)" },
      { key: "date", label: "Date (e.g. 14 March)" },
      { key: "day", label: "Day" },
      { key: "month", label: "Month" },
    ],
    defaults: { target: "{user.id}" },
    summary: "Get the birthday of {target}",
    run: async (ctx, config) => {
      requirePlugin(ctx, "birthdays", "Birthdays");
      const member = await resolveMember(ctx, config.target);
      const store = await import("../../../birthdays/functions/store.js");
      const bday = store.isOptedOut(ctx.guild.id, member.id) ? null : store.getBirthdayIn(ctx.guild.id, member.id);
      if (!bday) return { outputs: { has: false, date: "", day: "", month: "" } };
      const monthName = new Date(Date.UTC(2000, bday.month - 1, 1)).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
      return { outputs: { has: true, date: `${bday.day} ${monthName}`, day: bday.day, month: monthName } };
    },
  },
  {
    type: "passport_check",
    category: "plugins",
    label: "Check Passport",
    description: "Whether someone passed Passport verification here.",
    icon: "passport",
    plugin: "passport",
    pluginLabel: "Passport",
    fields: [userTargetField()],
    outputs: [{ key: "verified", label: "Verified (true or false)" }],
    defaults: { target: "{user.id}" },
    summary: "Check Passport for {target}",
    run: async (ctx, config) => {
      requirePlugin(ctx, "passport", "Passport");
      const member = await resolveMember(ctx, config.target);
      const { getPassportVerification } = await import("../../../passport/functions/store.js");
      const row = await getPassportVerification(ctx.guild.id, member.id);
      return { outputs: { verified: Boolean(row) } };
    },
  },
  {
    type: "team_clock",
    category: "plugins",
    label: "Clock in or out",
    description: "Start or end a Team Control shift for the person who ran it.",
    icon: "badge",
    plugin: "team_control",
    pluginLabel: "Team Control",
    fields: [{ key: "mode", label: "Do", kind: "select", options: [{ value: "in", label: "Clock in" }, { value: "out", label: "Clock out" }] }],
    outputs: [{ key: "ok", label: "Done (true or false)" }],
    defaults: { mode: "in" },
    summary: "Clock {mode}",
    run: async (ctx, config) => {
      const { loadTeamRuntime } = await import("../../../team_control/functions/members.js");
      const runtime = await loadTeamRuntime(ctx.guild.id);
      if (!runtime) throw new StepError("The Team Control plugin is turned off in this server.", "plugin_off");
      const shifts = await import("../../../team_control/functions/shifts.js");
      if (!(await shifts.maySelfShift(ctx.runner, runtime.guildConfig, runtime.config))) throw new StepError("You can't start or end shifts here.");
      const result = config.mode === "out" ? await shifts.endOwnShift(ctx.runner, runtime.config) : await shifts.startShift(ctx.runner, runtime.config, null);
      if (!result.ok) throw new StepError(result.error);
      return { outputs: { ok: true } };
    },
  },
];

