import type { Guild, GuildMember, TextChannel, User } from "discord.js";

export type TemplateContext = {
  user?: User | null;
  member?: GuildMember | null;
  guild?: Guild | null;
  channel?: TextChannel | null;
  extra?: Record<string, string>;
};

export function renderTemplate(template: string, ctx: TemplateContext): string {
  const user = ctx.member?.user ?? ctx.user;
  const guild = ctx.guild ?? ctx.member?.guild ?? ctx.channel?.guild ?? null;

  const vars: Record<string, string> = {
    user: user ? `<@${user.id}>` : "",
    user_id: user?.id ?? "",
    user_name: user?.username ?? "",
    user_tag: user?.tag ?? "",
    user_display: ctx.member?.displayName ?? user?.displayName ?? user?.username ?? "",
    guild: guild?.name ?? "",
    guild_id: guild?.id ?? "",
    guild_member_count: guild ? String(guild.memberCount) : "",
    channel: ctx.channel ? `<#${ctx.channel.id}>` : "",
    channel_id: ctx.channel?.id ?? "",
    channel_name: ctx.channel?.name ?? "",
    ...(ctx.extra ?? {}),
  };

  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}
