import type { Client } from "discord.js";
import { getLogger } from "./logger.js";
const log = getLogger("core");

export type ScheduledTask = {
  id: string;
  intervalMs: number;
  run: (client: Client) => Promise<void>;
};

const tasks = new Map<string, ReturnType<typeof setInterval>>();

export function registerIntervalTask(task: ScheduledTask): void {
  if (tasks.has(task.id)) {
    clearInterval(tasks.get(task.id)!);
  }
  // Overlap guard: a run that's still going when the next interval fires is not started twice
  // (a slow poll would otherwise stack up copies of itself and double its work).
  let running = false;
  tasks.set(
    task.id,
    setInterval(() => {
      if (running) return;
      running = true;
      Promise.resolve()
        .then(() => task.run(globalClient!))
        .catch((err) => {
          log.error(`Scheduled task "${task.id}" failed:`, err);
        })
        .finally(() => {
          running = false;
        });
    }, task.intervalMs),
  );
}

let globalClient: Client | null = null;

export function setSchedulerClient(client: Client): void {
  globalClient = client;
}

export function initScheduler(client: Client, intervalTasks: ScheduledTask[]): void {
  globalClient = client;
  for (const task of intervalTasks) {
    registerIntervalTask(task);
  }
}

export function stopScheduler(): void {
  for (const handle of tasks.values()) {
    clearInterval(handle);
  }
  tasks.clear();
  globalClient = null;
}
