import type { SourcePos } from "./types.js";

export class DreamcodeError extends Error {
  readonly phase: "parse" | "validate" | "runtime";
  readonly pos?: SourcePos;

  constructor(phase: "parse" | "validate" | "runtime", message: string, pos?: SourcePos) {
    const loc = pos ? ` (line ${pos.line}, col ${pos.column})` : "";
    super(`${message}${loc}`);
    this.name = "DreamcodeError";
    this.phase = phase;
    this.pos = pos;
  }
}

export class DreamcodeAbort extends Error {
  readonly userMessage: string;

  constructor(userMessage: string) {
    super(userMessage);
    this.name = "DreamcodeAbort";
    this.userMessage = userMessage;
  }
}
