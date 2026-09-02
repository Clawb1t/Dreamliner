import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import type { RolePanel, RolePanelRole } from "../../../config/schemas/rolePanels.js";
import { buildEmbed } from "../../persist/functions/messageBuilder.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { renderTemplate, type TemplateContext } from "../../../core/templates.js";
import { rolePanelButtonCustomId } from "../customIds.js";

export type RolePanelBuildContext = {
  client: Client;
  guild: Guild;
  channel: GuildTextBasedChannel;
};

function parseButtonStyle(style: string): ButtonStyle {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Secondary;
  }
}

/** Chunks role buttons into rows of 5. Label falls back to the role's live name when empty. */
export function buildRolePanelButtonRows(
  panelId: string,
  roles: RolePanelRole[],
  guild?: Guild,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();

  for (const role of roles) {
    if (current.components.length >= 5) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
    }
    const liveRole = guild?.roles.cache.get(role.role_id);
    const label = (role.label.trim() || liveRole?.name || "Role").slice(0, 80);
    const button = new ButtonBuilder()
      .setCustomId(rolePanelButtonCustomId(panelId, role.role_id))
      .setLabel(label)
      .setStyle(parseButtonStyle(role.style));
    const emoji = parseComponentEmoji(role.emoji);
    if (emoji) button.setEmoji(emoji);
    current.addComponents(button);
  }

  if (current.components.length > 0) rows.push(current);
  return rows;
}

/** Deliberately narrower than MessageCreateOptions (no `flags`) so it's valid for both send and edit. */
export type RolePanelMessagePayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: [] };
};

export type BuiltRolePanelMessage = {
  payload: RolePanelMessagePayload;
  empty: boolean;
};

/** Builds the content+embed(+button rows, for trigger_type "button") payload for post_mode "bot". */
export function buildRolePanelPayload(panel: RolePanel, ctx: RolePanelBuildContext): BuiltRolePanelMessage {
  const templateCtx: TemplateContext = { guild: ctx.guild, channel: ctx.channel as TemplateContext["channel"] };
  const content = renderTemplate(panel.content ?? "", templateCtx).trim();
  const embed = buildEmbed(panel.embed, { client: ctx.client, guild: ctx.guild, channel: ctx.channel });
  const rows = panel.trigger_type === "button" ? buildRolePanelButtonRows(panel.id, panel.roles, ctx.guild) : [];

  const empty = !content && !embed && rows.length === 0;
  const payload: RolePanelMessagePayload = {
    ...(content ? { content } : {}),
    ...(embed ? { embeds: [embed] } : {}),
    ...(rows.length ? { components: rows } : {}),
    allowedMentions: { parse: [] },
  };

  return { payload, empty };
}

function embedSnapshot(embed: Message["embeds"][number] | EmbedBuilder) {
  const data = embed.toJSON();
  return {
    title: data.title ?? "",
    description: data.description ?? "",
    color: data.color ?? null,
    thumbnail: data.thumbnail?.url ?? "",
    image: data.image?.url ?? "",
    footer: data.footer?.text ?? "",
    fields: (data.fields ?? []).map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })),
  };
}

function buttonSnapshot(components: Message["components"] | RolePanelMessagePayload["components"]) {
  const buttons: Array<{ label: string; style: number | string }> = [];
  for (const row of components ?? []) {
    const children = "components" in row && Array.isArray(row.components) ? row.components : [];
    for (const component of children) {
      const data =
        component && typeof component === "object" && "data" in component
          ? (component.data as { label?: string; style?: number })
          : (component as { label?: string; style?: number });
      buttons.push({ label: typeof data.label === "string" ? data.label : "", style: data.style ?? "" });
    }
  }
  return buttons;
}

/** Fingerprint of a *live* Discord message — compared against `rolePanelPayloadFingerprint`. */
export function rolePanelMessageFingerprint(message: Pick<Message, "content" | "embeds" | "components">): string {
  return JSON.stringify({
    content: message.content ?? "",
    embeds: message.embeds.map(embedSnapshot),
    buttons: buttonSnapshot(message.components),
  });
}

/** Fingerprint of a panel's built payload, including the reaction-emoji set for reaction panels. */
export function rolePanelPayloadFingerprint(built: BuiltRolePanelMessage, panel: RolePanel): string {
  const embed = built.payload.embeds?.[0];
  return JSON.stringify({
    content: built.payload.content ?? "",
    embeds: embed ? [embedSnapshot(embed as EmbedBuilder)] : [],
    buttons: buttonSnapshot(built.payload.components),
    reactions: panel.trigger_type === "reaction" ? panel.roles.map((r) => r.emoji) : [],
  });
}

export function rolePanelHasContent(panel: RolePanel): boolean {
  if (panel.content.trim()) return true;
  if (panel.trigger_type === "button" && panel.roles.length) return true;
  if (!panel.embed.enabled) return false;
  return Boolean(
    panel.embed.title.trim() ||
      panel.embed.description.trim() ||
      panel.embed.image_url.trim() ||
      panel.embed.author_name.trim() ||
      panel.embed.footer_text.trim() ||
      panel.embed.fields.some((f) => f.name.trim() && f.value.trim()),
  );
}
