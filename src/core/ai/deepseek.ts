import OpenAI from "openai";

/**
 * DeepSeek client for the Characters plugin. DeepSeek's API is OpenAI-compatible, so this is the
 * same SDK as `client.ts` with its own key, base URL and model, kept fully separate so Autopilot
 * and the tickets AI Responder are never affected by it.
 *
 * Env: DEEPSEEK_API_KEY (required), DEEPSEEK_BASE_URL (default https://api.deepseek.com),
 * DEEPSEEK_CHARACTER_MODEL (default deepseek-flash).
 */

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const TIMEOUT_MS = 25_000;

export type DeepSeekMessage = { role: "system" | "user" | "assistant"; content: string };
export type DeepSeekUsage = { input: number; output: number };

let client: OpenAI | null = null;
let clientKey = "";

export function isDeepSeekConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export function deepSeekModel(): string {
  return process.env.DEEPSEEK_CHARACTER_MODEL?.trim() || DEFAULT_MODEL;
}

function getClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set, characters are unavailable.");
  const baseURL = process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const key = `${apiKey}|${baseURL}`;
  if (!client || clientKey !== key) {
    // Retries are done here (once, on 429/5xx), not by the SDK, so a slow API can't stack them up.
    client = new OpenAI({ apiKey, baseURL, timeout: TIMEOUT_MS, maxRetries: 0 });
    clientKey = key;
  }
  return client;
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  // Timeouts and dropped connections have no status.
  const name = (error as { name?: unknown })?.name;
  return name === "APIConnectionError" || name === "APIConnectionTimeoutError";
}

async function withOneRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isRetryable(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return run();
  }
}

function usageOf(response: OpenAI.Chat.Completions.ChatCompletion): DeepSeekUsage {
  return { input: response.usage?.prompt_tokens ?? 0, output: response.usage?.completion_tokens ?? 0 };
}

/** One chat completion: the reply text plus token usage. Throws when nothing came back. */
export async function chatCompletion(input: {
  messages: DeepSeekMessage[];
  maxTokens: number;
  temperature: number;
}): Promise<{ text: string; usage: DeepSeekUsage }> {
  const response = await withOneRetry(() =>
    getClient().chat.completions.create({
      model: deepSeekModel(),
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      messages: input.messages,
    }),
  );
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("DeepSeek did not return any text.");
  return { text, usage: usageOf(response) };
}

/**
 * JSON-mode call (`response_format: json_object`). DeepSeek has no strict schema mode, so the
 * prompt has to describe the shape and the caller validates what comes back. Returns the parsed
 * JSON, or throws when it isn't valid JSON after one retry.
 */
export async function structured(input: {
  messages: DeepSeekMessage[];
  maxTokens?: number;
}): Promise<{ value: unknown; usage: DeepSeekUsage }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await withOneRetry(() =>
      getClient().chat.completions.create({
        model: deepSeekModel(),
        max_tokens: input.maxTokens ?? 400,
        temperature: 0,
        messages: input.messages,
        response_format: { type: "json_object" },
      }),
    );
    const text = response.choices[0]?.message?.content?.trim();
    if (!text) continue;
    try {
      return { value: JSON.parse(text), usage: usageOf(response) };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DeepSeek returned an unreadable answer${lastError instanceof Error ? `: ${lastError.message}` : ""}.`);
}
