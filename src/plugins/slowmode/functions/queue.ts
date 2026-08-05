const chains = new Map<string, Promise<unknown>>();

/** Run tasks for the same key strictly one-after-another. */
export function runExclusive(key: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return current;
}
