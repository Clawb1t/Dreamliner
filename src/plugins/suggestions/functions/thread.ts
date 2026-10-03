import { ChannelType, type Client, type Message, type ThreadAutoArchiveDuration } from "discord.js";
import type { SuggestionsConfig } from "../../../config/schemas/suggestions.js";
import type { Suggestion } from "./store.js";
import { resolveTextChannel } from "./embeds.js";

/** "Suggestion #12" style thread names: {number}, {author} ("Anonymous" for anonymous
 *  suggestions) and {content} (the first line of the suggestion). */
export function suggestionThreadName(
  template: string,
  suggestion: Pick<Suggestion, "suggestionNumber" | "content" | "anonymous">,
  authorName: string,
): string {
  const content = suggestion.content.split("\n")[0]!.trim().slice(0, 80);
  const name = template
    .replaceAll("{number}", String(suggestion.suggestionNumber))
    .replaceAll("{author}", suggestion.anonymous ? "Anonymous" : authorName)
    .replaceAll("{content}", content)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return name || `Suggestion #${suggestion.suggestionNumber}`;
}

/** Starts the discussion thread on a newly posted suggestion, when the server turned it on. A
 *  missing permission just means no thread: the suggestion itself is already posted. */
export async function startSuggestionThread(
  client: Client,
  message: Message,
  suggestion: Suggestion,
  config: SuggestionsConfig,
): Promise<void> {
  if (!config.auto_thread || message.hasThread) return;
  if (message.channel.type !== ChannelType.GuildText && message.channel.type !== ChannelType.GuildAnnouncement) return;
  const author = suggestion.anonymous ? null : await client.users.fetch(suggestion.authorId).catch(() => null);
  await message
    .startThread({
      name: suggestionThreadName(config.thread_name, suggestion, author?.displayName ?? author?.username ?? "Someone"),
      autoArchiveDuration: config.thread_auto_archive_minutes as ThreadAutoArchiveDuration,
      reason: `Discussion for suggestion #${suggestion.suggestionNumber}`,
    })
    .catch(() => null);
}

/** Closes a suggestion's thread: locked and archived when it's denied (the discussion stays
 *  readable), deleted along with a deleted suggestion. A thread started from a message has that
 *  message's id, so the feed post's id finds it. */
export async function closeSuggestionThread(
  client: Client,
  channelId: string | null,
  messageId: string | null,
  action: "lock" | "delete",
): Promise<void> {
  if (!channelId || !messageId) return;
  const channel = await resolveTextChannel(client, channelId);
  const thread = channel && "threads" in channel ? await channel.threads.fetch(messageId).catch(() => null) : null;
  if (!thread) return;
  if (action === "delete") {
    await thread.delete("Suggestion deleted").catch(() => null);
    return;
  }
  await thread.setLocked(true, "Suggestion denied").catch(() => null);
  await thread.setArchived(true, "Suggestion denied").catch(() => null);
}
