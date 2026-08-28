/** A guild-scoped custom slash command: always exactly one reply, text or embed. */

export type CommandEmbedConfig = {
  authorName: string;
  authorIconUrl: string;
  authorUrl: string;
  title: string;
  titleUrl: string;
  description: string;
  thumbnailUrl: string;
  imageUrl: string;
  color: number | null;
  footerText: string;
  timestamp: boolean;
};

export type CommandProgram = {
  version: 2;
  description: string;
  ephemeral: boolean;
  responseType: "text" | "embed";
  /** Only applies to text replies: pick one of `variants` at random instead of using `content`. */
  random: boolean;
  content: string;
  variants: string[];
  embed: CommandEmbedConfig;
};

export const EMPTY_EMBED: CommandEmbedConfig = {
  authorName: "",
  authorIconUrl: "",
  authorUrl: "",
  title: "",
  titleUrl: "",
  description: "",
  thumbnailUrl: "",
  imageUrl: "",
  color: null,
  footerText: "",
  timestamp: false,
};

export function emptyProgram(): CommandProgram {
  return {
    version: 2,
    description: "",
    ephemeral: false,
    responseType: "text",
    random: false,
    content: "",
    variants: [],
    embed: EMPTY_EMBED,
  };
}

/** Tokens available in text content and every embed text field. */
export const COMMAND_TOKENS = ["user", "mention", "server", "channel"] as const;
export type CommandTokenKey = (typeof COMMAND_TOKENS)[number];

export function interpolateTokens(text: string, tokens: Record<CommandTokenKey, string>): string {
  return text.replace(/\{(user|mention|server|channel)\}/g, (_m, key: CommandTokenKey) => tokens[key] ?? "");
}

export class CommandProgramError extends Error {}

const MAX_TEXT_LEN = 2000;
const MAX_VARIANTS = 10;
const MAX_PROGRAM_BYTES = 8 * 1024;
const URL_RE = /^https?:\/\/\S+$/i;

function checkUrl(value: string, field: string): void {
  if (value && !URL_RE.test(value)) {
    throw new CommandProgramError(`${field} must be a valid http(s) URL`);
  }
}

/** Validate an untrusted JSON payload as a CommandProgram. Throws CommandProgramError on failure. */
export function validateProgram(input: unknown): CommandProgram {
  if (typeof input !== "object" || input === null) {
    throw new CommandProgramError("program is required");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_PROGRAM_BYTES) {
    throw new CommandProgramError(`Commands must be under ${MAX_PROGRAM_BYTES} bytes`);
  }

  const p = input as Partial<CommandProgram>;

  if (typeof p.description !== "string" || p.description.length < 1 || p.description.length > 100) {
    throw new CommandProgramError("Description must be 1-100 characters");
  }
  if (typeof p.ephemeral !== "boolean") {
    throw new CommandProgramError("ephemeral must be a boolean");
  }
  if (p.responseType !== "text" && p.responseType !== "embed") {
    throw new CommandProgramError("responseType must be 'text' or 'embed'");
  }
  if (typeof p.random !== "boolean") {
    throw new CommandProgramError("random must be a boolean");
  }

  const program: CommandProgram = {
    version: 2,
    description: p.description,
    ephemeral: p.ephemeral,
    responseType: p.responseType,
    random: p.random,
    content: "",
    variants: [],
    embed: EMPTY_EMBED,
  };

  if (program.responseType === "text") {
    if (program.random) {
      const variants = Array.isArray(p.variants) ? p.variants.filter((v) => typeof v === "string") : [];
      const trimmed = variants.map((v) => v.trim()).filter(Boolean);
      if (trimmed.length < 1) {
        throw new CommandProgramError("Add at least one reply for a random reply list");
      }
      if (trimmed.length > MAX_VARIANTS) {
        throw new CommandProgramError(`Random replies are capped at ${MAX_VARIANTS}`);
      }
      for (const v of trimmed) {
        if (v.length > MAX_TEXT_LEN) throw new CommandProgramError(`A reply is over ${MAX_TEXT_LEN} characters`);
      }
      program.variants = trimmed;
    } else {
      const content = typeof p.content === "string" ? p.content.trim() : "";
      if (!content) throw new CommandProgramError("Message content is required");
      if (content.length > MAX_TEXT_LEN) throw new CommandProgramError(`Message content is over ${MAX_TEXT_LEN} characters`);
      program.content = content;
    }
  } else {
    const e = { ...EMPTY_EMBED, ...(typeof p.embed === "object" && p.embed ? p.embed : {}) };
    if (!e.title.trim() && !e.description.trim() && !e.authorName.trim()) {
      throw new CommandProgramError("An embed needs at least a title, description, or author name");
    }
    if (e.title.length > 256) throw new CommandProgramError("Embed title is over 256 characters");
    if (e.description.length > 4096) throw new CommandProgramError("Embed description is over 4096 characters");
    if (e.authorName.length > 256) throw new CommandProgramError("Author name is over 256 characters");
    if (e.footerText.length > 2048) throw new CommandProgramError("Footer text is over 2048 characters");
    checkUrl(e.titleUrl, "Title URL");
    checkUrl(e.authorUrl, "Author link URL");
    checkUrl(e.authorIconUrl, "Author icon URL");
    checkUrl(e.thumbnailUrl, "Thumbnail URL");
    checkUrl(e.imageUrl, "Image URL");
    if (e.color !== null && (typeof e.color !== "number" || e.color < 0 || e.color > 0xffffff)) {
      throw new CommandProgramError("Embed color is invalid");
    }
    if (typeof e.timestamp !== "boolean") {
      throw new CommandProgramError("timestamp must be a boolean");
    }
    program.embed = e;
  }

  return program;
}
