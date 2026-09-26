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

export type ChatTurn = {
  role: "system" | "user" | "assistant";
  content: string;
  /** Image data URLs (or https URLs) attached to a user turn, e.g. dashboard screenshots. */
  images?: string[];
};

function toApiMessage(turn: ChatTurn): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (turn.role === "user" && turn.images?.length) {
    return {
      role: "user",
      content: [
        { type: "text", text: turn.content },
        ...turn.images.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
      ],
    };
  }
  return { role: turn.role, content: turn.content };
}

/** Structured-output call (OpenAI strict JSON schema mode) for multi-turn flows like the AI
 * setup wizard, where the response shape must be machine-parseable rather than free text.
 *
 * Large strict schemas occasionally make the model loop on whitespace until it hits the token
 * limit, leaving unfinished JSON. That's detected (finish_reason "length" or unparseable output)
 * and retried once at temperature 0, which reliably produces a complete answer. */
export async function generateStructured(input: {
  messages: ChatTurn[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<unknown> {
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  for (const temperature of [0.3, 0]) {
    const response = await getClient().chat.completions.create({
      model,
      max_tokens: input.maxTokens ?? 600,
      temperature,
      messages: input.messages.map(toApiMessage),
      response_format: {
        type: "json_schema",
        json_schema: { name: input.schemaName, strict: true, schema: input.schema },
      },
    });
    const choice = response.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) continue;
    if (choice?.finish_reason === "length") continue;
    try {
      return JSON.parse(text);
    } catch {
      // Malformed despite strict mode: try once more.
    }
  }
  throw new Error("Autopilot's answer came back incomplete. Please try again.");
}
