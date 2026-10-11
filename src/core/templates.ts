import type { Guild, GuildMember, TextChannel, User } from "discord.js";

/**
 * `extra` is the sanctioned injection point for plugin-supplied dynamic data (things that need a
 * DB lookup, like an economy balance or a message count) rather than the static Discord objects
 * above. This file intentionally stays free of cross-plugin imports (it's pulled into low-level
 * plugins widely, so importing economy/utility/suggestions here directly would risk import
 * cycles) -- plugins that want dynamic vars should build their `extra` map with the shared
 * helper in `src/core/templateExtras.ts` (`buildDynamicExtras`) and pass the result here.
 */
export type TemplateContext = {
  user?: User | null;
  member?: GuildMember | null;
  guild?: Guild | null;
  channel?: TextChannel | null;
  extra?: Record<string, string>;
};

/**
 * Names people choose themselves (usernames, nicknames, channel names) can contain mention syntax
 * like `<@&roleId>` or `@everyone`. A zero-width space keeps them as plain text, so dropping a
 * member's name into a message can never ping anyone.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/<(?=[@#&!:]|a:)/g, "<\u200b").replace(/@(everyone|here)/gi, "@\u200b$1");
}

/** Merges `ctx.extra` last so plugin-supplied dynamic vars (see `TemplateContext` above) win
 * over the static ones computed here. */
export function buildTemplateVars(ctx: TemplateContext): Record<string, string> {
  const user = ctx.member?.user ?? ctx.user;
  const guild = ctx.guild ?? ctx.member?.guild ?? ctx.channel?.guild ?? null;
  const avatarUrl = user?.displayAvatarURL({ size: 256, extension: "png" }) ?? "";
  const guildIconUrl = guild?.iconURL({ size: 256, extension: "png" }) ?? "";
  const memberCount = guild ? String(guild.memberCount) : "";
  const userName = neutralizeMentions(user?.username ?? "");
  const display = neutralizeMentions(ctx.member?.displayName ?? user?.displayName ?? user?.username ?? "");

  const vars: Record<string, string> = {
    user: user ? `<@${user.id}>` : "",
    user_id: user?.id ?? "",
    user_name: userName,
    user_tag: neutralizeMentions(user?.tag ?? ""),
    user_display: display,
    username: userName,
    guild: guild?.name ?? "",
    guild_id: guild?.id ?? "",
    guild_member_count: memberCount,
    member_count: memberCount,
    memberCount,
    server: guild?.name ?? "",
    channel: ctx.channel ? `<#${ctx.channel.id}>` : "",
    channel_id: ctx.channel?.id ?? "",
    channel_name: neutralizeMentions(ctx.channel?.name ?? ""),
    avatar_url: avatarUrl,
    guild_icon_url: guildIconUrl,
    ...(ctx.extra ?? {}),
  };

  return vars;
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  const vars = buildTemplateVars(ctx);
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}
