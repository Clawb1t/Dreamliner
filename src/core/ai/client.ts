import OpenAI from "openai";

const DEFAULT_MODEL = "gpt-4.1-mini";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set, Autopilot is unavailable.");
  }
  if (!client) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function generateText(input: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const response = await getClient().chat.completions.create({
    model,
    max_tokens: input.maxTokens ?? 300,
    temperature: 0.8,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.prompt },
    ],
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Autopilot did not return any text.");
  }
  return text;
}

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

/** Structured-output call (OpenAI strict JSON schema mode) for multi-turn flows like the AI
 * setup wizard, where the response shape must be machine-parseable rather than free text. */
export async function generateStructured(input: {
  messages: ChatTurn[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<unknown> {
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const response = await getClient().chat.completions.create({
    model,
    max_tokens: input.maxTokens ?? 600,
    temperature: 0.6,
    messages: input.messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: input.schemaName, strict: true, schema: input.schema },
    },
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Autopilot did not return any text.");
  }
  return JSON.parse(text);
}
