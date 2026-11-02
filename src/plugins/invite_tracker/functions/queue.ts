/**
 * Per-guild promise chains, so one server's joins and leaves are handled strictly one at a time
 * (each join diffs the invite list against the one before it, so two running at once would both
 * see the same increment). A guild's entry is removed as soon as it has nothing left to run.
 */
export class GuildQueue {
  private readonly chains = new Map<string, { tail: Promise<void>; depth: number }>();

  /**
   * Runs `job` after every job already queued for this guild. `job` gets how many jobs are
   * queued behind it when it starts, so a burst can be handled cheaply.
   */
  run<T>(guildId: string, job: (behind: number) => Promise<T>): Promise<T> {
    const entry = this.chains.get(guildId) ?? { tail: Promise.resolve(), depth: 0 };
    entry.depth += 1;
    const result = entry.tail.then(() => job(entry.depth - 1));
    entry.tail = result.then(
      () => this.settle(guildId, entry),
      () => this.settle(guildId, entry),
    );
    this.chains.set(guildId, entry);
    return result;
  }

  private settle(guildId: string, entry: { depth: number }): void {
    entry.depth -= 1;
    if (entry.depth === 0 && this.chains.get(guildId) === entry) this.chains.delete(guildId);
  }

  /** Jobs queued or running for this guild. */
  depth(guildId: string): number {
    return this.chains.get(guildId)?.depth ?? 0;
  }

  /** Guilds with work queued (for tests and memory checks). */
  get size(): number {
    return this.chains.size;
  }
}

export const joinQueue = new GuildQueue();
