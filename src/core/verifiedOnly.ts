import type { GuildMember } from "discord.js";
import { APP_EMOJI } from "./appEmojis.js";
import { defaultTranslator, type Translator } from "../i18n/index.js";

/**
 * "Verified members only": a `require_passport` toggle shared by Suggestions, Reviews,
 * Applications, Tickets and Giveaways. Passport is loaded through a guarded dynamic import, and
 * the requirement is ignored whenever Passport is off (hasMemberPassedPassport already treats a
 * disabled Passport or a bypass-role member as passed) or fails to load.
 */
export type PassportRequirementResult = { ok: true } | { ok: false; message: string };

export type PassportStatus = {
  passed: boolean;
  /** Where the member can verify. */
  verifyUrl: string;
  /** Passport's verify channel, when one is set. */
  channelId: string;
};

export function passportRequiredMessage(
  t: Translator,
  status: Pick<PassportStatus, "verifyUrl" | "channelId">,
): string {
  const how = status.channelId
    ? t(
        "verifiedOnly.howChannel",
        "Press **Verify** in <#{channel}>, or verify here: {url}",
        { channel: status.channelId, url: status.verifyUrl },
      )
    : t("verifiedOnly.howUrl", "Verify here: {url}", { url: status.verifyUrl });
  return `${APP_EMOJI.verified} ${t(
    "verifiedOnly.body",
    "This is for verified members only. Pass Passport verification first, then try again.",
  )}\n${how}`;
}

async function loadPassportStatus(member: GuildMember): Promise<PassportStatus | null> {
  try {
    const [{ hasMemberPassedPassport }, { getPassportConfig }, { configManager }, { getPassportUrl }] =
      await Promise.all([
        import("../plugins/passport/functions/gate.js"),
        import("../plugins/passport/functions/loadConfig.js"),
        import("../config/manager.js"),
        import("./docsUrl.js"),
      ]);
    const passed = await hasMemberPassedPassport(member);
    if (passed) return { passed, verifyUrl: "", channelId: "" };
    const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
    const config = getPassportConfig(guildConfig);
    return { passed, verifyUrl: getPassportUrl(member.guild.id), channelId: config.channel_id ?? "" };
  } catch {
    return null;
  }
}

/** Ok when `required` is off, Passport is off/unavailable, or the member has passed it. */
export async function checkPassportRequirement(
  member: GuildMember,
  required: boolean | undefined,
  t: Translator = defaultTranslator,
  loadStatus: (member: GuildMember) => Promise<PassportStatus | null> = loadPassportStatus,
): Promise<PassportRequirementResult> {
  if (!required) return { ok: true };
  const status = await loadStatus(member);
  if (!status || status.passed) return { ok: true };
  return { ok: false, message: passportRequiredMessage(t, status) };
}
