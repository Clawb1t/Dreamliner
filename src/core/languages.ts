export type LanguageInfo = {
  code: string;
  name: string;
  /** Unicode regional flag used for Discord reactions and display. */
  flag: string;
};

export const DEFAULT_LANGUAGE_CODE = "en";

/** Curated languages for server default + /translate. */
export const LANGUAGES: LanguageInfo[] = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "de", name: "German", flag: "🇩🇪" },
  { code: "it", name: "Italian", flag: "🇮🇹" },
  { code: "pt", name: "Portuguese", flag: "🇵🇹" },
  { code: "nl", name: "Dutch", flag: "🇳🇱" },
  { code: "pl", name: "Polish", flag: "🇵🇱" },
  { code: "ru", name: "Russian", flag: "🇷🇺" },
  { code: "uk", name: "Ukrainian", flag: "🇺🇦" },
  { code: "tr", name: "Turkish", flag: "🇹🇷" },
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "he", name: "Hebrew", flag: "🇮🇱" },
  { code: "hi", name: "Hindi", flag: "🇮🇳" },
  { code: "bn", name: "Bengali", flag: "🇧🇩" },
  { code: "ja", name: "Japanese", flag: "🇯🇵" },
  { code: "ko", name: "Korean", flag: "🇰🇷" },
  { code: "zh-CN", name: "Chinese (Simplified)", flag: "🇨🇳" },
  { code: "zh-TW", name: "Chinese (Traditional)", flag: "🇹🇼" },
  { code: "th", name: "Thai", flag: "🇹🇭" },
  { code: "vi", name: "Vietnamese", flag: "🇻🇳" },
  { code: "id", name: "Indonesian", flag: "🇮🇩" },
  { code: "ms", name: "Malay", flag: "🇲🇾" },
  { code: "sv", name: "Swedish", flag: "🇸🇪" },
  { code: "no", name: "Norwegian", flag: "🇳🇴" },
  { code: "da", name: "Danish", flag: "🇩🇰" },
  { code: "fi", name: "Finnish", flag: "🇫🇮" },
  { code: "cs", name: "Czech", flag: "🇨🇿" },
  { code: "ro", name: "Romanian", flag: "🇷🇴" },
  { code: "hu", name: "Hungarian", flag: "🇭🇺" },
  { code: "el", name: "Greek", flag: "🇬🇷" },
  { code: "bg", name: "Bulgarian", flag: "🇧🇬" },
  { code: "hr", name: "Croatian", flag: "🇭🇷" },
  { code: "sk", name: "Slovak", flag: "🇸🇰" },
  { code: "sl", name: "Slovenian", flag: "🇸🇮" },
  { code: "lt", name: "Lithuanian", flag: "🇱🇹" },
  { code: "lv", name: "Latvian", flag: "🇱🇻" },
  { code: "et", name: "Estonian", flag: "🇪🇪" },
  { code: "fil", name: "Filipino", flag: "🇵🇭" },
  { code: "sw", name: "Swahili", flag: "🇰🇪" },
];

export const LANGUAGE_CODES = LANGUAGES.map((lang) => lang.code) as [string, ...string[]];

const byCode = new Map(LANGUAGES.map((lang) => [lang.code.toLowerCase(), lang]));

/** Normalize Google / Discord locale codes onto our catalog when possible. */
export function normalizeLanguageCode(code: string | null | undefined): string {
  if (!code) return DEFAULT_LANGUAGE_CODE;
  const raw = code.trim();
  if (!raw) return DEFAULT_LANGUAGE_CODE;

  const lower = raw.toLowerCase();
  if (byCode.has(lower)) return byCode.get(lower)!.code;

  // Chinese variants
  if (lower === "zh" || lower === "zh-cn" || lower === "zh_hans") return "zh-CN";
  if (lower === "zh-tw" || lower === "zh-hk" || lower === "zh_hant") return "zh-TW";

  // Common aliases
  if (lower === "nb" || lower === "nn") return "no";
  if (lower === "iw") return "he";
  if (lower === "tl") return "fil";
  if (lower === "jw") return "id";
  if (lower === "pt-br" || lower === "pt-pt") return "pt";

  const base = lower.split(/[-_]/)[0] ?? lower;
  if (byCode.has(base)) return byCode.get(base)!.code;

  return raw;
}

export function getLanguage(code: string | null | undefined): LanguageInfo {
  const normalized = normalizeLanguageCode(code);
  return byCode.get(normalized.toLowerCase()) ?? {
    code: normalized,
    name: normalized,
    flag: "🏳️",
  };
}

export function flagForLanguage(code: string | null | undefined): string {
  return getLanguage(code).flag;
}

export function languagesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeLanguageCode(a).toLowerCase() === normalizeLanguageCode(b).toLowerCase();
}

export function languageChoices(query = ""): Array<{ name: string; value: string }> {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? LANGUAGES.filter(
        (lang) =>
          lang.code.toLowerCase().includes(q) ||
          lang.name.toLowerCase().includes(q) ||
          lang.flag.includes(q),
      )
    : LANGUAGES;
  return filtered.slice(0, 25).map((lang) => ({
    name: `${lang.flag} ${lang.name}`,
    value: lang.code,
  }));
}
