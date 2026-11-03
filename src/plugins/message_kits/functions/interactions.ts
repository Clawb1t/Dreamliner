import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { buildFormModal, readFormAnswer, type FormQuestion } from "../../../core/formModal.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { createPruner } from "../../../core/mapPrune.js";
import { autoGrantableRoleIds, safeAddRole, safeRemoveRole, safeToggleRole } from "../../../core/roles.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { MK_FORM_PREFIX, MK_PREFIX } from "./constants.js";
import { findComponent, type KitAction, type KitDocument, type KitFormAction } from "./document.js";
import { renderText } from "./render.js";
import { describeDiscordError, KitSendError, kitDocumentOf, kitVars, loadKitsRuntime, prepareKitMessage, sendableDocumentOf } from "./send.js";
import { getKit, getKitById, type KitRecord } from "./store.js";

const log = getLogger("message_kits");

const UNAVAILABLE = "This button isn't available any more.";
const MENU_UNAVAILABLE = "This menu isn't available any more.";
const FORM_UNAVAILABLE = "This form isn't available any more.";

// ── Custom ids ──────────────────────────────────────────────────────────────

/** `mk:<kitId>:<componentId>` → parts, or null. */
export function parseKitCustomId(customId: string): { kitId: number; componentId: string } | null {
  const match = /^mk:(\d{1,15}):([a-z0-9_-]{1,24})$/.exec(customId);
  return match ? { kitId: Number(match[1]), componentId: match[2]! } : null;
}

/** `mk:f:<kitId>:<componentId>[:<optionId>]` → parts, or null. */
export function parseKitFormId(customId: string): { kitId: number; componentId: string; optionId: string | null } | null {
  const match = /^mk:f:(\d{1,15}):([a-z0-9_-]{1,24})(?::([a-z0-9_-]{1,24}))?$/.exec(customId);
  return match ? { kitId: Number(match[1]), componentId: match[2]!, optionId: match[3] ?? null } : null;
}

export function kitFormCustomId(kitId: number, componentId: string, optionId?: string | null): string {
  return `${MK_FORM_PREFIX}${kitId}:${componentId}${optionId ? `:${optionId}` : ""}`;
}

// ── Shared ──────────────────────────────────────────────────────────────────

type KitInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

async function replyEphemeral(interaction: KitInteraction, content: string): Promise<void> {
  const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } } as const;
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
  else await interaction.reply(payload);
}

type Loaded = { kit: KitRecord; doc: KitDocument; guild: Guild | null };

/**
 * The kit behind a component, always its CURRENT document (editing a kit changes what every sent
 * copy's buttons do). In a server the kit must belong to it; in DMs (test sends) any kit by id.
 */
async function loadKit(interaction: KitInteraction, kitId: number): Promise<Loaded | "disabled" | null> {
  if (interaction.guildId) {
    const kit = getKit(interaction.guildId, kitId);
    if (!kit) return null;
    const runtime = await loadKitsRuntime(interaction.guildId);
    if (!runtime.enabled) return "disabled";
    return { kit, doc: kitDocumentOf(kit), guild: interaction.guild };
  }
  const kit = getKitById(kitId);
  if (!kit) return null;
  return { kit, doc: kitDocumentOf(kit), guild: interaction.client.guilds.cache.get(kit.guildId) ?? null };
}

/** loadKit for a handler: replies itself when the plugin is off (returns null then too). */
async function loadOrReply(interaction: KitInteraction, kitId: number, unavailable: string): Promise<Loaded | null> {
  const loaded = await loadKit(interaction, kitId);
  if (loaded === "disabled") {
    await replyEphemeral(interaction, "Message Kits is turned off in this server.");
    return null;
  }
  if (!loaded) await replyEphemeral(interaction, unavailable);
  return loaded;
}

async function memberOf(interaction: KitInteraction, guild: Guild): Promise<GuildMember | null> {
  const cached = guild.members.cache.get(interaction.user.id);
  return cached ?? (await guild.members.fetch(interaction.user.id).catch(() => null));
}

// ── Role actions ────────────────────────────────────────────────────────────

const COOLDOWN_MS = 3_000;
const cooldowns = new Map<string, number>();
const pruneCooldowns = createPruner(cooldowns, (until, now) => until <= now);

/** Form answers are posted (and may ping a role), so one person can send one every 30 seconds. */
const FORM_COOLDOWN_MS = 30_000;

function onCooldown(guildId: string, userId: string, scope: "role" | "form" = "role"): boolean {
  const now = Date.now();
  pruneCooldowns(now);
  const key = `${scope}:${guildId}:${userId}`;
  if ((cooldowns.get(key) ?? 0) > now) return true;
  cooldowns.set(key, now + (scope === "form" ? FORM_COOLDOWN_MS : COOLDOWN_MS));
  return false;
}

/** The role a form submission may ping: an existing role, never @everyone (its id is the server's). */
export function formPingRole(guild: Pick<Guild, "id" | "roles">, pingOnForm: boolean, roleId: string | null): string | null {
  if (!pingOnForm || !roleId || roleId === guild.id) return null;
  return guild.roles.cache.has(roleId) ? roleId : null;
}

async function runRoleActions(interaction: KitInteraction, loaded: Loaded, actions: Extract<KitAction, { type: "role" }>[]): Promise<void> {
  const guild = loaded.guild;
  if (!guild || !interaction.inGuild()) {
    await replyEphemeral(interaction, "Use this button in the server to get its roles.");
    return;
  }
  if (onCooldown(guild.id, interaction.user.id)) {
    await replyEphemeral(interaction, "Slow down a little and try again in a few seconds.");
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await memberOf(interaction, guild);
  if (!member) {
    await interaction.editReply({ content: "Couldn't find you in this server." });
    return;
  }

  const added: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  const reason = `Message Kits: ${loaded.kit.name}`.slice(0, 100);
  for (const action of actions) {
    const allowed = new Set(autoGrantableRoleIds(guild, action.role_ids));
    for (const roleId of action.role_ids) {
      if (!allowed.has(roleId)) {
        failed.push(roleId);
        continue;
      }
      const hadRole = member.roles.cache.has(roleId);
      const result =
        action.mode === "add"
          ? await safeAddRole(member, roleId, reason)
          : action.mode === "remove"
            ? await safeRemoveRole(member, roleId, reason)
            : await safeToggleRole(member, roleId, reason);
      if (!result.ok) failed.push(roleId);
      else if (action.mode === "add" && !hadRole) added.push(roleId);
      else if (action.mode === "remove" && hadRole) removed.push(roleId);
      else if (action.mode === "toggle") (hadRole ? removed : added).push(roleId);
    }
  }

  const custom = actions.find((action) => action.reply.trim())?.reply ?? "";
  let content: string;
  if (custom && failed.length === 0) {
    content = renderText(custom, kitVars(guild, interaction.channel, { user: interaction.user, member }).vars).slice(0, 2000);
  } else {
    const parts: string[] = [];
    if (added.length) parts.push(`Added ${added.map((id) => `<@&${id}>`).join(", ")}.`);
    if (removed.length) parts.push(`Removed ${removed.map((id) => `<@&${id}>`).join(", ")}.`);
    if (!added.length && !removed.length && !failed.length) parts.push("You already had that.");
    if (failed.length)
      parts.push(
        `Couldn't change ${failed.map((id) => `<@&${id}>`).join(", ")}: Dreamliner can only give roles below its own that have no staff permissions. Let a server manager know.`,
      );
    content = parts.join(" ");
  }
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

// ── Reply with a kit ────────────────────────────────────────────────────────

async function replyWithKit(interaction: KitInteraction, loaded: Loaded, kitId: number): Promise<void> {
  const guild = loaded.guild;
  const target = guild ? getKit(guild.id, kitId) : null;
  if (!guild || !target) {
    await replyEphemeral(interaction, "The message this button shows was deleted.");
    return;
  }
  const member = interaction.inGuild() ? await memberOf(interaction, guild) : null;
  try {
    const prepared = prepareKitMessage(guild, target.id, sendableDocumentOf(target), kitVars(guild, interaction.channel, { user: interaction.user, member }));
    const flags = (prepared.body.flags & (MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds)) | MessageFlags.Ephemeral;
    await interaction.reply({ ...prepared.body, files: prepared.files, flags } as InteractionReplyOptions);
  } catch (error) {
    if (error instanceof KitSendError) {
      await replyEphemeral(interaction, "That message isn't ready yet. Ask a server manager to finish it on the dashboard.");
      return;
    }
    await replyEphemeral(interaction, `Couldn't show that message: ${describeDiscordError(error)}`);
  }
}

// ── Forms ───────────────────────────────────────────────────────────────────

/** Form questions in the shared modal builder's shape. */
export function formQuestions(form: KitFormAction): FormQuestion[] {
  return form.fields.map((field) => ({
    id: "00000000-0000-4000-8000-000000000000",
    label: field.label,
    type: "text",
    style: field.style,
    required: field.required,
    placeholder: field.placeholder,
    min_length: Math.min(field.min, field.max),
    max_length: field.max,
  }));
}

async function showForm(interaction: ButtonInteraction | StringSelectMenuInteraction, loaded: Loaded, form: KitFormAction, componentId: string, optionId: string | null): Promise<void> {
  if (!interaction.inGuild()) {
    await replyEphemeral(interaction, "Use this form in the server.");
    return;
  }
  const modal = buildFormModal({
    customId: kitFormCustomId(loaded.kit.id, componentId, optionId),
    title: form.title,
    questions: formQuestions(form),
    fieldId: (index) => `q${index}`,
  });
  await interaction.showModal(modal);
}

function formFrom(doc: KitDocument, componentId: string, optionId: string | null): KitFormAction | null {
  const ref = findComponent(doc, componentId);
  if (!ref) return null;
  const action = ref.kind === "button" ? ref.button.action : ref.select.options.find((option) => option.id === optionId)?.action;
  return action?.type === "form" ? action : null;
}

export async function handleKitModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const parsed = parseKitFormId(interaction.customId);
  if (!parsed) return false;
  if (!interaction.inGuild() || !interaction.guild) {
    await replyEphemeral(interaction, "Use this form in the server.");
    return true;
  }
  const loaded = await loadOrReply(interaction, parsed.kitId, FORM_UNAVAILABLE);
  if (!loaded) return true;
  const form = formFrom(loaded.doc, parsed.componentId, parsed.optionId);
  if (!form) {
    await replyEphemeral(interaction, FORM_UNAVAILABLE);
    return true;
  }
  const guild = interaction.guild;
  if (onCooldown(guild.id, interaction.user.id, "form")) {
    await replyEphemeral(interaction, "You just sent this form. Wait half a minute before sending it again.");
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const questions = formQuestions(form);
  const answers = questions.map((question, index) => {
    let answer = "";
    try {
      answer = readFormAnswer(question, `q${index}`, interaction.fields)?.answer ?? "";
    } catch {
      answer = "";
    }
    return { label: question.label, answer };
  });

  const channel = await fetchGuildTextChannel(interaction.client, guild.id, form.channel_id);
  if (!channel) {
    await interaction.editReply({ content: "Your answers couldn't be delivered: the form's channel is missing. Let a server manager know." });
    return true;
  }

  const embed = new EmbedBuilder()
    .setTitle(form.title.slice(0, 256))
    .setAuthor({ name: `${interaction.user.username}`.slice(0, 256), iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
    .setDescription(`Submitted by <@${interaction.user.id}> (\`${interaction.user.id}\`)`)
    .setFooter({ text: `Message Kits · ${loaded.kit.name}`.slice(0, 2048) })
    .setTimestamp(new Date());
  if (loaded.doc.format === "classic") {
    const color = loaded.doc.embeds[0]?.color;
    if (color !== null && color !== undefined) embed.setColor(color);
  }
  let truncated = false;
  for (const { label, answer } of answers) {
    const text = neutralizeMentions(answer.trim()) || "*No answer*";
    if (text.length > 1024) truncated = true;
    embed.addFields({ name: label.slice(0, 256), value: text.length > 1024 ? `${text.slice(0, 1020)}…` : text });
  }
  const files = truncated
    ? [new AttachmentBuilder(Buffer.from(answers.map((a) => `${a.label}\n${a.answer}\n`).join("\n"), "utf8"), { name: "answers.txt" })]
    : [];

  const { config } = await loadKitsRuntime(guild.id);
  const ping = formPingRole(guild, config.ping_on_form, form.ping_role_id);
  try {
    await channel.send({
      ...(ping ? { content: `<@&${ping}>` } : {}),
      embeds: [embed],
      files,
      allowedMentions: ping ? { roles: [ping] } : { parse: [] },
    });
  } catch (error) {
    log.warn(`Kit form delivery failed in ${guild.id}: ${describeDiscordError(error)}`);
    await interaction.editReply({ content: `Your answers couldn't be delivered (${describeDiscordError(error)}). Let a server manager know.` });
    return true;
  }
  const member = await memberOf(interaction, guild);
  const confirmation = form.confirmation.trim()
    ? renderText(form.confirmation, kitVars(guild, interaction.channel, { user: interaction.user, member }).vars).slice(0, 2000)
    : "Thanks! Your answers were sent.";
  await interaction.editReply({ content: confirmation, allowedMentions: { parse: [] } });
  return true;
}

// ── Buttons and menus ───────────────────────────────────────────────────────

async function runAction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  loaded: Loaded,
  action: KitAction,
  componentId: string,
  optionId: string | null,
): Promise<void> {
  switch (action.type) {
    case "role":
      return runRoleActions(interaction, loaded, [action]);
    case "kit":
      return replyWithKit(interaction, loaded, action.kit_id);
    case "form":
      return showForm(interaction, loaded, action, componentId, optionId);
    case "none":
      await replyEphemeral(interaction, "This doesn't do anything yet.");
  }
}

export async function handleKitButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(MK_PREFIX)) return false;
  const parsed = parseKitCustomId(interaction.customId);
  if (!parsed) return false;
  const loaded = await loadOrReply(interaction, parsed.kitId, UNAVAILABLE);
  if (!loaded) return true;
  const ref = findComponent(loaded.doc, parsed.componentId);
  if (ref?.kind !== "button" || ref.button.style === "link") {
    await replyEphemeral(interaction, UNAVAILABLE);
    return true;
  }
  if (ref.button.disabled) {
    await replyEphemeral(interaction, UNAVAILABLE);
    return true;
  }
  await runAction(interaction, loaded, ref.button.action, parsed.componentId, null);
  return true;
}

export async function handleKitSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(MK_PREFIX)) return false;
  const parsed = parseKitCustomId(interaction.customId);
  if (!parsed) return false;
  const loaded = await loadOrReply(interaction, parsed.kitId, MENU_UNAVAILABLE);
  if (!loaded) return true;
  const ref = findComponent(loaded.doc, parsed.componentId);
  if (ref?.kind !== "select" || ref.select.disabled) {
    await replyEphemeral(interaction, MENU_UNAVAILABLE);
    return true;
  }
  const options = interaction.values
    .map((value) => ref.select.options.find((option) => option.id === value))
    .filter((option): option is NonNullable<typeof option> => Boolean(option));
  if (!options.length) {
    await replyEphemeral(interaction, "That option isn't available any more.");
    return true;
  }
  if (options.length === 1) {
    await runAction(interaction, loaded, options[0]!.action, parsed.componentId, options[0]!.id);
    return true;
  }
  // Several choices: only role actions are allowed there (validation enforces it).
  const roleActions = options.map((option) => option.action).filter((action): action is Extract<KitAction, { type: "role" }> => action.type === "role");
  if (!roleActions.length) {
    await replyEphemeral(interaction, "Those options don't do anything yet.");
    return true;
  }
  await runRoleActions(interaction, loaded, roleActions);
  return true;
}
