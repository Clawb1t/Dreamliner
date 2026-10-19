import { parentPort } from "node:worker_threads";

/**
 * The worker side of offload.ts: loads the named export from the named module and runs it. Since
 * this is not the main thread, the `offloaded` wrapper around that export calls the real
 * implementation directly, using this thread's own database connection.
 */

const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
const modules = new Map<string, Promise<Record<string, unknown>>>();

function load(modulePath: string): Promise<Record<string, unknown>> {
  let loaded = modules.get(modulePath);
  if (!loaded) {
    // Only module paths written in our own source reach here, never user input.
    const href = new URL(`../${modulePath}.${ext}`, import.meta.url).href;
    // Running from source (tsx): a worker's own dynamic imports skip tsx's .js -> .ts mapping, so
    // go through tsx's API. Compiled output (dist) just imports normally.
    loaded =
      ext === "ts"
        ? import("tsx/esm/api").then(({ tsImport }) => tsImport(href, import.meta.url) as Promise<Record<string, unknown>>)
        : (import(href) as Promise<Record<string, unknown>>);
    modules.set(modulePath, loaded);
  }
  return loaded;
}

parentPort?.on("message", async (message: { id: number; modulePath: string; name: string; args: unknown[] }) => {
  try {
    const mod = await load(message.modulePath);
    const fn = mod[message.name];
    if (typeof fn !== "function") throw new Error(`${message.modulePath} has no function ${message.name}`);
    const value = await (fn as (...args: unknown[]) => Promise<unknown>)(...message.args);
    parentPort?.postMessage({ id: message.id, ok: true, value });
  } catch (error) {
    parentPort?.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
