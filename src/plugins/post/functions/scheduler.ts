import type { Client } from "discord.js";
import { renderTemplate } from "../../../core/templates.js";
import { getDueScheduledPosts, removeScheduledPost } from "./store.js";

export async function processDuePosts(client: Client): Promise<void> {
  const due = await getDueScheduledPosts();
  for (const post of due) {
    try {
      const guild = await client.guilds.fetch(post.guildId).catch(() => null);
      if (!guild) {
        await removeScheduledPost(post.id);
        continue;
      }

      const channel = await guild.channels.fetch(post.channelId).catch(() => null);
      if (!channel?.isTextBased() || !("send" in channel)) {
        await removeScheduledPost(post.id);
        continue;
      }

      const content = renderTemplate(post.content, { guild });
      await channel.send({ content });
    } catch (err) {
      console.error(`Failed to deliver scheduled post #${post.id}:`, err);
    } finally {
      await removeScheduledPost(post.id);
    }
  }
}
