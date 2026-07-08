import type { Client } from "discord.js";

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
  tasks.set(
    task.id,
    setInterval(() => {
      task.run(globalClient!).catch((err) => {
        console.error(`Scheduled task "${task.id}" failed:`, err);
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
