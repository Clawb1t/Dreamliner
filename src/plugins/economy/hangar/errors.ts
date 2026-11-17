/**
 * One error type for every Hangar rule a request can break. `code` is stable (the website and the
 * Discord layer switch on it, and it doubles as the i18n key suffix `economy.hangar.error.<code>`),
 * `template` is the English fallback with {placeholders}, `vars` fills them, and `message` is the
 * filled-in English text.
 */
export type HangarErrorCode =
  | "not_found"
  | "not_owner"
  | "locked"
  | "insufficient_coins"
  | "insufficient_parts"
  | "invalid"
  | "pack_unavailable"
  | "empty_pool"
  | "hangar_full"
  | "cooldown"
  | "limit"
  | "not_craftable"
  | "max_level"
  | "requirements"
  | "conflict"
  | "expired"
  | "forbidden";

const STATUS: Record<HangarErrorCode, number> = {
  not_found: 404,
  not_owner: 403,
  locked: 409,
  insufficient_coins: 402,
  insufficient_parts: 402,
  invalid: 400,
  pack_unavailable: 409,
  empty_pool: 409,
  hangar_full: 409,
  cooldown: 429,
  limit: 409,
  not_craftable: 400,
  max_level: 409,
  requirements: 400,
  conflict: 409,
  expired: 410,
  forbidden: 403,
};

export class HangarError extends Error {
  readonly status: number;
  constructor(
    readonly code: HangarErrorCode,
    readonly template: string,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(fillVars(template, vars));
    this.name = "HangarError";
    this.status = STATUS[code];
  }
}

/** An ISO timestamp passed as a var (e.g. a cooldown's end). Discord shows these as <t:...> tags. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Plain-text fallback for a timestamp (the website and logs): "18 Nov 2026, 12:24 UTC". */
function readableTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

function fillVars(message: string, vars: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(key in vars)) return match;
    const value = vars[key]!;
    return typeof value === "string" && ISO_TIME.test(value) ? readableTime(value) : String(value);
  });
}

export function hangarError(code: HangarErrorCode, template: string, vars: Record<string, string | number> = {}): HangarError {
  return new HangarError(code, template, vars);
}
