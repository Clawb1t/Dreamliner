/**
 * Channel lists that act as filters ("only in these channels", "ignore these channels") may hold
 * category ids as well as channel ids. A category entry means every channel inside it, including
 * channels created later. Every such check goes through {@link channelInList}, so a stored category
 * id works the same everywhere.
 *
 * Which config fields allow categories is listed once, in `CATEGORY_CHANNEL_FIELDS`
 * (src/config/categoryChannelFields.ts). The dashboard reads that list from the editor meta, so
 * only fields whose bot-side check uses this helper offer categories in the picker.
 */

/** The smallest channel shape the match needs. discord.js guild channels and threads both fit. */
export type ChannelScopeSource = {
  id: string;
  /** A channel's category, or a thread's parent channel. */
  parentId?: string | null;
  /** The cached parent (resolved from the same guild's cache by discord.js). For a thread this is
   *  the parent channel, whose `parentId` is the thread's category. */
  parent?: { id: string; parentId?: string | null } | null;
};

/** The ids a channel can be matched by: itself, its category, and for a thread its parent channel
 *  and that channel's category. */
export function channelScopeIds(channel: ChannelScopeSource | null | undefined): string[] {
  if (!channel?.id) return [];
  const ids = [channel.id];
  if (channel.parentId) ids.push(channel.parentId);
  const grandParent = channel.parent?.parentId;
  if (grandParent) ids.push(grandParent);
  return [...new Set(ids)];
}

/** Whether `channel` is in `list`, directly or through its category (or, for a thread, its parent
 *  channel or that channel's category). A bare id string only matches itself. */
export function channelInList(
  list: readonly string[] | null | undefined,
  channel: ChannelScopeSource | string | null | undefined,
): boolean {
  if (!list?.length || !channel) return false;
  const ids = typeof channel === "string" ? [channel] : channelScopeIds(channel);
  return ids.some((id) => list.includes(id));
}

type GuildChannelCache = { channels: { cache: { get(id: string): ChannelScopeSource | undefined } } };

/**
 * A channel id resolved against ONE guild's channel cache, for checks that only have an id (e.g.
 * `interaction.channelId`). Never looks outside that guild: an id that isn't one of its channels
 * just matches itself.
 */
export function guildChannelScope(
  guild: GuildChannelCache | null | undefined,
  channelId: string | null | undefined,
): ChannelScopeSource | null {
  if (!channelId) return null;
  return guild?.channels.cache.get(channelId) ?? { id: channelId };
}
