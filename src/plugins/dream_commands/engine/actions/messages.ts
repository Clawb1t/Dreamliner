import { ChannelType, ThreadAutoArchiveDuration, type Message } from "discord.js";
import type { ActionDef } from "../action.js";
import { arr, bool, channelTargetField, num, str } from "../action.js";
import type { CatalogField } from "../fields.js";
import { messageIsEmpty, renderMessage } from "../message.js";
import {
  checkBuilderChannelPermission,
  checkOptionTarget,
  checkRunnerModerates,
  discordCall,
  requireBotPermission,
  resolveMember,
  resolveRunMessage,
  resolveTextChannel,
  spendApi,
  StepError,
  type RunCtx,
} from "../runtime.js";
import { LIMITS, type MessageSpec } from "../types.js";
import { interpolate } from "../vars.js";
import { countCreation } from "../limits.js";

export const messageField = (label = "Message"): CatalogField => ({ key: "message", label, kind: "message", required: true });

export const ephemeralField: CatalogField = {
  key: "ephemeral",
  label: "Who sees the reply",
  kind: "select",
  options: [
    { value: "default", label: "Command default" },
    { value: "yes", label: "Only the person who ran it" },
    { value: "no", label: "Everyone in the channel" },
  ],
};

/** "reply" (the first reply) or the id of an earlier step that sent a message. */
export const messageRefField: CatalogField = {
  key: "messageRef",
  label: "Message",
  kind: "text",
  maxLength: 24,
  placeholder: "reply",
  help: "The reply, or a message an earlier step sent in this run.",
};

export function resolveEphemeral(ctx: RunCtx, value: unknown): boolean {
  if (value === "yes" || value === true) return true;
  if (value === "no" || value === false) return false;
  return ctx.program.ephemeral;
}

export function render(ctx: RunCtx, spec: MessageSpec, components: unknown[] = []) {
  return renderMessage(spec, { vars: ctx.vars, rng: ctx.rng, runnerId: ctx.runner.id, optionUserIds: ctx.optionUserIds }, components);
}

function messageOutputs(message: Message | null): { outputs: Record<string, string>; trusted?: string[] } {
  if (!message) return { outputs: {} };
  const url = message.guildId ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}` : "";
  return { outputs: { "message.id": message.id, "message.url": url }, trusted: ["message.id", "message.url"] };
}

const messageOutputsList = [
  { key: "message.id", label: "Message ID" },
  { key: "message.url", label: "Message link" },
];

function validateMessage(config: Record<string, unknown>, v: { issue(field: string, message: string): void }) {
  const spec = config.message as MessageSpec | undefined;
  if (spec && messageIsEmpty(spec)) v.issue("message", "Write something for the message.");
}

/** Records a message this run sent so later steps (react, pin, thread) can use it. */
export function remember(ctx: RunCtx, stepId: string, message: Message | null, isReply: boolean): void {
  if (!message?.id) return;
  const entry = { channelId: message.channelId ?? ctx.channelId, messageId: message.id };
  ctx.messages.set(stepId, entry);
  if (isReply && !ctx.messages.has("reply")) ctx.messages.set("reply", entry);
}

const messageRefValidate = (config: Record<string, unknown>, v: { issue(f: string, m: string): void; earlier: { id: string; type: string }[] }) => {
  const ref = str(config, "messageRef") || "reply";
  const senders = new Set(["reply", "send_message", "buttons", "select_menu", "send_webhook"]);
  if (ref === "reply") {
    if (!v.earlier.some((s) => s.type === "reply" || s.type === "buttons" || s.type === "select_menu")) v.issue("messageRef", "Add a Reply step before this one.");
    return;
  }
  const step = v.earlier.find((s) => s.id === ref);
  if (!step || !senders.has(step.type)) v.issue("messageRef", "Pick the reply or an earlier step that sends a message.");
};

const BLOCKED_WEBHOOK_NAMES = /(discord|clyde|dreamliner|system|official|staff|moderator|admin|support team|everyone|here)/i;

export const messageActions: ActionDef[] = [
  {
    type: "reply",
    category: "messages",
    label: "Reply",
    description: "Answer the person who ran the command with a message.",
    icon: "message",
    fields: [messageField("Reply"), ephemeralField],
    outputs: messageOutputsList,
    summary: "Reply with a message",
    validate: validateMessage,
    run: async (ctx, config, step) => {
      const spec = config.message as MessageSpec;
      const ephemeral = resolveEphemeral(ctx, config.ephemeral);
      spendApi(ctx);
      const message = await ctx.responder.send(render(ctx, spec), ephemeral);
      if (!ephemeral) remember(ctx, step.id, message, true);
      else if (message && !ctx.messages.has("reply")) ctx.messages.set("reply:ephemeral", { channelId: ctx.channelId, messageId: message.id });
      return messageOutputs(ephemeral ? null : message);
    },
  },
  {
    type: "send_message",
    category: "messages",
    label: "Send a message",
    description: "Post a message in a channel.",
    icon: "send",
    fields: [channelTargetField("channel", "Channel", ["text", "announcement", "voice", "forum"]), messageField()],
    outputs: messageOutputsList,
    summary: "Send a message in {channel}",
    botPerms: () => ["SendMessages"],
    validate: validateMessage,
    run: async (ctx, config, step) => {
      const channel = await resolveTextChannel(ctx, config.channel);
      requireBotPermission(ctx, "SendMessages", channel);
      checkBuilderChannelPermission(ctx, channel, "SendMessages");
      const payload = render(ctx, config.message as MessageSpec);
      const message = await discordCall(ctx, () => (channel as unknown as { send(p: unknown): Promise<Message> }).send(payload));
      remember(ctx, step.id, message, false);
      return messageOutputs(message);
    },
  },
  {
    type: "send_dm",
    category: "messages",
    label: "Send a DM",
    description: "Send a direct message to the person who ran it, or someone picked in an option.",
    icon: "dm",
    fields: [
      { key: "target", label: "Send to", kind: "user_target", required: true, help: "Only the person who ran it, or a member picked in an option." },
      messageField(),
      { key: "failSilently", label: "Carry on if their DMs are closed", kind: "boolean" },
    ],
    outputs: [{ key: "sent", label: "Sent (true or false)" }],
    defaults: { target: "{user.id}", failSilently: true },
    summary: "DM {target}",
    validate: validateMessage,
    run: async (ctx, config) => {
      const member = await resolveMember(ctx, config.target);
      checkOptionTarget(ctx, member, true);
      if (member.user.bot) throw new StepError("Bots can't receive DMs.");
      ctx.counters.dms += 1;
      if (ctx.counters.dms > LIMITS.dmsPerRun) throw new StepError(`A run can send at most ${LIMITS.dmsPerRun} DMs.`);
      const payload = render(ctx, config.message as MessageSpec);
      // DMs never ping anyone.
      payload.allowedMentions = { parse: [] };
      spendApi(ctx);
      try {
        await member.send(payload as never);
        return { outputs: { sent: true } };
      } catch {
        if (bool(config, "failSilently")) return { outputs: { sent: false } };
        throw new StepError(`${member.displayName} doesn't accept DMs from this server.`);
      }
    },
  },
  {
    type: "edit_reply",
    category: "messages",
    label: "Edit the reply",
    description: "Change the first reply this command sent.",
    icon: "edit",
    fields: [messageField("New message")],
    outputs: [],
    summary: "Edit the reply",
    validate: (config, v) => {
      validateMessage(config, v);
      if (!v.earlier.some((s) => ["reply", "buttons", "select_menu"].includes(s.type))) v.issue("message", "Add a Reply step before this one.");
    },
    run: async (ctx, config) => {
      spendApi(ctx);
      await ctx.responder.editFirst(render(ctx, config.message as MessageSpec));
    },
  },
  {
    type: "react",
    category: "messages",
    label: "React to a message",
    description: "Add emoji reactions to the reply or a message this command sent.",
    icon: "react",
    fields: [messageRefField, { key: "emojis", label: "Emojis", kind: "list", required: true, maxItems: 5, maxLength: 100, help: "Up to 5. Server emojis like <:name:id> must be from this server." }],
    outputs: [],
    defaults: { messageRef: "reply", emojis: ["👍"] },
    summary: "React with {emojis}",
    botPerms: () => ["AddReactions", "ReadMessageHistory"],
    validate: messageRefValidate,
    run: async (ctx, config) => {
      const message = await resolveRunMessage(ctx, config.messageRef);
      for (const raw of arr(config, "emojis").slice(0, 5)) {
        const custom = /^<a?:\w{2,32}:(\d{15,22})>$/.exec(raw.trim());
        if (custom && !ctx.guild.emojis.cache.has(custom[1]!)) throw new StepError("Only this server's own emojis can be used.");
        await discordCall(ctx, () => message.react(raw.trim()));
      }
    },
  },
  {
    type: "pin_message",
    category: "messages",
    label: "Pin a message",
    description: "Pin the reply or a message this command sent.",
    icon: "pin",
    fields: [messageRefField],
    outputs: [],
    defaults: { messageRef: "reply" },
    summary: "Pin the message",
    builderPerms: () => ["ManageMessages"],
    botPerms: () => ["ManageMessages"],
    validate: messageRefValidate,
    run: async (ctx, config) => {
      const message = await resolveRunMessage(ctx, config.messageRef);
      await discordCall(ctx, () => message.pin());
    },
  },
  {
    type: "delete_messages",
    category: "messages",
    label: "Delete recent messages",
    description: "Bulk delete up to 100 recent messages in a channel. The person running it needs Manage Messages too.",
    icon: "trash",
    fields: [
      channelTargetField("channel", "Channel", ["text", "announcement", "voice"]),
      { key: "count", label: "How many", kind: "number", integer: true, min: 1, max: LIMITS.bulkDelete, required: true },
      { key: "fromUser", label: "Only from this person (optional)", kind: "user_target", help: "Leave empty to delete anyone's messages." },
    ],
    outputs: [{ key: "deleted", label: "Messages deleted" }],
    defaults: { channel: "{channel.id}", count: 10, fromUser: "" },
    summary: "Delete the last {count} messages in {channel}",
    builderPerms: () => ["ManageMessages"],
    botPerms: () => ["ManageMessages", "ReadMessageHistory"],
    runnerPerms: () => ["ManageMessages"],
    run: async (ctx, config) => {
      checkRunnerModerates(ctx, "ManageMessages", null, "");
      const channel = await resolveTextChannel(ctx, config.channel);
      requireBotPermission(ctx, "ManageMessages", channel);
      checkBuilderChannelPermission(ctx, channel, "ManageMessages");
      if (!("bulkDelete" in channel)) throw new StepError("Messages can't be bulk deleted in that channel.");
      const count = Math.min(LIMITS.bulkDelete, Math.max(1, Math.floor(num(config, "count", 10))));
      let fromId: string | null = null;
      if (str(config, "fromUser").trim()) {
        const target = await resolveMember(ctx, config.fromUser);
        fromId = target.id;
      }
      const deleted = await discordCall(
        ctx,
        async () => {
          const bulk = channel as unknown as { messages: { fetch(o: { limit: number }): Promise<Map<string, Message>> }; bulkDelete(m: Message[] | number, filterOld: boolean): Promise<Map<string, unknown>> };
          if (!fromId) return (await bulk.bulkDelete(count, true)).size;
          const recent = await bulk.messages.fetch({ limit: 100 });
          const mine = [...recent.values()].filter((m) => m.author.id === fromId).slice(0, count);
          if (!mine.length) return 0;
          return (await bulk.bulkDelete(mine, true)).size;
        },
        2,
      );
      return { outputs: { deleted } };
    },
  },
  {
    type: "publish_message",
    category: "messages",
    label: "Publish an announcement",
    description: "Publish a message this command sent in an announcement channel to following servers.",
    icon: "megaphone",
    fields: [messageRefField],
    outputs: [],
    summary: "Publish the message",
    builderPerms: () => ["ManageMessages"],
    validate: messageRefValidate,
    run: async (ctx, config) => {
      const message = await resolveRunMessage(ctx, config.messageRef);
      if (message.channel.type !== ChannelType.GuildAnnouncement) throw new StepError("Only messages in announcement channels can be published.");
      await discordCall(ctx, () => message.crosspost());
    },
  },
  {
    type: "create_thread",
    category: "messages",
    label: "Create a thread",
    description: "Start a thread on the reply, or a new thread in a channel.",
    icon: "thread",
    fields: [
      { key: "mode", label: "Where", kind: "select", options: [{ value: "message", label: "On a message this command sent" }, { value: "channel", label: "New thread in a channel" }] },
      { ...messageRefField, showIf: { key: "mode", in: ["message"] } },
      { ...channelTargetField("channel", "Channel", ["text", "announcement"]), required: false, showIf: { key: "mode", in: ["channel"] } },
      { key: "name", label: "Thread name", kind: "text", required: true, maxLength: 100, variables: true },
      { key: "private", label: "Private thread", kind: "boolean", showIf: { key: "mode", in: ["channel"] } },
      { key: "addRunner", label: "Add the person who ran it", kind: "boolean" },
      { key: "archiveHours", label: "Hide after inactivity", kind: "select", options: [{ value: "1", label: "1 hour" }, { value: "24", label: "24 hours" }, { value: "72", label: "3 days" }, { value: "168", label: "1 week" }] },
    ],
    outputs: [
      { key: "thread", label: "Thread mention" },
      { key: "thread.id", label: "Thread ID" },
      { key: "thread.name", label: "Thread name" },
    ],
    defaults: { mode: "message", messageRef: "reply", channel: "{channel.id}", name: "{user.name}'s thread", private: false, addRunner: true, archiveHours: "24" },
    summary: "Create a thread named {name}",
    creates: true,
    builderPerms: (c) => (c.mode === "channel" && c.private ? ["CreatePrivateThreads"] : ["CreatePublicThreads"]),
    botPerms: (c) => (c.mode === "channel" && c.private ? ["CreatePrivateThreads"] : ["CreatePublicThreads"]),
    validate: (config, v) => {
      if (config.mode === "message") messageRefValidate(config, v);
      else if (!str(config, "channel").trim()) v.issue("channel", "Pick a channel.");
    },
    run: async (ctx, config) => {
      const name = interpolate(str(config, "name"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 100) || "Thread";
      const minutes = (Number(str(config, "archiveHours")) || 24) * 60;
      const autoArchiveDuration = ([60, 1440, 4320, 10080].includes(minutes) ? minutes : 1440) as ThreadAutoArchiveDuration;
      await countCreation(ctx, "thread");
      let thread;
      if (config.mode === "channel") {
        const channel = await resolveTextChannel(ctx, config.channel);
        const priv = bool(config, "private");
        checkBuilderChannelPermission(ctx, channel, priv ? "CreatePrivateThreads" : "CreatePublicThreads");
        requireBotPermission(ctx, priv ? "CreatePrivateThreads" : "CreatePublicThreads", channel);
        if (!("threads" in channel)) throw new StepError("Threads can't be made in that channel.");
        thread = await discordCall(ctx, () =>
          (channel as unknown as { threads: { create(o: unknown): Promise<import("discord.js").ThreadChannel> } }).threads.create({
            name,
            autoArchiveDuration,
            type: priv ? ChannelType.PrivateThread : ChannelType.PublicThread,
            reason: `Custom command /${ctx.commandName}`,
          }),
        );
      } else {
        const message = await resolveRunMessage(ctx, config.messageRef);
        thread = await discordCall(ctx, () => message.startThread({ name, autoArchiveDuration, reason: `Custom command /${ctx.commandName}` }));
      }
      ctx.created.channels.add(thread.id);
      if (bool(config, "addRunner")) await discordCall(ctx, () => thread.members.add(ctx.runner.id)).catch(() => null);
      return { outputs: { thread: `<#${thread.id}>`, "thread.id": thread.id, "thread.name": thread.name }, trusted: ["thread", "thread.id"] };
    },
  },
  {
    type: "send_webhook",
    category: "messages",
    label: "Send as a custom name",
    description: "Post a message with a custom name and avatar (through a webhook).",
    icon: "webhook",
    fields: [
      channelTargetField("channel", "Channel", ["text", "announcement"]),
      { key: "name", label: "Name", kind: "text", required: true, maxLength: 80, variables: true },
      { key: "avatarUrl", label: "Avatar image link", kind: "text", maxLength: 500, variables: true, placeholder: "https://..." },
      messageField(),
    ],
    outputs: messageOutputsList,
    defaults: { channel: "{channel.id}", name: "Announcer", avatarUrl: "" },
    summary: "Send as {name} in {channel}",
    builderPerms: () => ["ManageWebhooks"],
    botPerms: () => ["ManageWebhooks"],
    validate: (config, v) => {
      validateMessage(config, v);
      if (BLOCKED_WEBHOOK_NAMES.test(str(config, "name"))) v.issue("name", "That name could be mistaken for Discord, Dreamliner or staff. Pick another.");
      const spec = config.message as MessageSpec | undefined;
      if (spec?.format === "container") v.issue("message", "Custom-name messages can be text or embed.");
    },
    run: async (ctx, config, step) => {
      const channel = await resolveTextChannel(ctx, config.channel);
      if (!("fetchWebhooks" in channel)) throw new StepError("Webhooks can't post in that channel.");
      requireBotPermission(ctx, "ManageWebhooks", channel);
      checkBuilderChannelPermission(ctx, channel, "ManageWebhooks");
      const name = interpolate(str(config, "name"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 80) || "Announcer";
      if (BLOCKED_WEBHOOK_NAMES.test(name) || name.toLowerCase() === ctx.client.user?.username.toLowerCase()) {
        throw new StepError("That name could be mistaken for Discord, Dreamliner or staff.");
      }
      const avatarRaw = interpolate(str(config, "avatarUrl"), ctx.vars, { mode: "raw", rng: ctx.rng });
      const { safeUrl } = await import("../message.js");
      const avatarURL = avatarRaw ? safeUrl(avatarRaw) : undefined;
      const host = channel as unknown as {
        fetchWebhooks(): Promise<Map<string, { owner?: { id: string } | null; name: string; send(o: unknown): Promise<Message> }>>;
        createWebhook(o: { name: string; reason: string }): Promise<{ send(o: unknown): Promise<Message> }>;
      };
      const hooks = await discordCall(ctx, () => host.fetchWebhooks());
      let hook: { send(o: unknown): Promise<Message> } | undefined = [...hooks.values()].find((h) => h.owner?.id === ctx.client.user?.id && h.name === "Dreamliner Commands");
      if (!hook) hook = await discordCall(ctx, () => host.createWebhook({ name: "Dreamliner Commands", reason: `Custom command /${ctx.commandName}` }));
      const payload = render(ctx, config.message as MessageSpec);
      const message = await discordCall(ctx, () => hook!.send({ ...payload, username: name, avatarURL }));
      remember(ctx, step.id, message, false);
      return messageOutputs(message);
    },
  },
];
