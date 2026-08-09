/**
 * Platform dashboard superusers (Discord snowflakes).
 *
 * Checked only after the request has passed the shared bridge Bearer secret.
 * The website must send `userId` from the Auth.js session discordId — never
 * trust a browser-supplied identity without that secret + session chain.
 *
 * Extra IDs: DASHBOARD_SUPERUSER_IDS (comma-separated).
 */
const BUILTIN_SUPERUSER_IDS = ["272397639855898624"] as const;

function parseEnvSuperuserIds(): string[] {
  const raw = process.env.DASHBOARD_SUPERUSER_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter((id) => /^\d{17,20}$/.test(id));
}

const SUPERUSER_IDS = new Set<string>([...BUILTIN_SUPERUSER_IDS, ...parseEnvSuperuserIds()]);

export function isDashboardSuperuser(discordId: string | null | undefined): boolean {
  if (!discordId || !/^\d{17,20}$/.test(discordId)) return false;
  return SUPERUSER_IDS.has(discordId);
}
