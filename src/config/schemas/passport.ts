import { z } from "zod";
import { boolPerm, channelId, roleId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";
import { zWelcomeEmbedConfig } from "./welcome.js";

const colorInt = (description: string, fallback?: number) => {
  const base = z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .describe(description);
  return fallback === undefined ? base.optional() : base.default(fallback);
};

const snowflakeList = (help: string) =>
  z
    .array(z.string())
    .default([])
    .describe(help);

export const zPassportPingConfig = z.strictObject({
  enabled: z.boolean().default(true).describe("Ping new members in the verify channel."),
  ping_style: z
    .enum(["mention", "none"])
    .default("mention")
    .describe("Whether the join ping mentions the member."),
  content: z
    .string()
    .max(2000)
    .default("Hey {user}, welcome to **{guild}**.\n\nTap **Verify** to unlock the rest of the server.")
    .describe("Join ping content. Supports placeholders."),
  embed: zWelcomeEmbedConfig.default({}),
  button_label: z.string().max(80).default("Verify").describe("Label on the Verify link button."),
  button_emoji: z
    .string()
    .max(128)
    .default("")
    .describe("Optional emoji on the Verify button (unicode or <:name:id>)."),
  also_dm: z.boolean().default(false).describe("Also DM the member a Verify link."),
  delete_on_verify: z.boolean().default(true).describe("Delete the join ping after they verify."),
  delete_on_leave: z.boolean().default(true).describe("Delete the join ping if they leave first."),
  delete_after_seconds: z
    .number()
    .int()
    .min(0)
    .max(604800)
    .default(0)
    .describe("Delete the join ping after this many seconds (0 = keep)."),
});

export const zPassportPanelConfig = z.strictObject({
  content: z
    .string()
    .max(2000)
    .default("Welcome to **{guild}**.\n\nTap **Verify** to unlock the rest of the server.")
    .describe("Persistent panel content. Supports placeholders."),
  embed: zWelcomeEmbedConfig.default({}),
  button_label: z.string().max(80).default("Verify").describe("Label on the persistent Verify button."),
  button_emoji: z.string().max(128).default("").describe("Optional emoji on the persistent Verify button."),
});

export const zPassportPageConfig = z.strictObject({
  headline: z
    .string()
    .max(200)
    .default("Welcome to {guild}")
    .describe("Page headline. Supports placeholders."),
  body: z
    .string()
    .max(2000)
    .default("Sign in with Discord and complete a quick check to prove you're human.")
    .describe("Page body text. Supports placeholders."),
  rules: z.string().max(4000).default("").describe("Optional rules block shown above the captcha."),
  login_button_label: z.string().max(80).default("Continue with Discord").describe("Sign-in button label."),
  verify_button_label: z.string().max(80).default("Verify").describe("Verify button label after captcha."),
  inherit_accent: z
    .boolean()
    .default(true)
    .describe("Use this server's public accent color on the Passport page."),
  accent_color: colorInt("Page accent when inherit_accent is off.", 0x5662f5),
  background: z
    .enum(["none", "color", "url", "guild_banner"])
    .default("none")
    .describe("Page background source."),
  background_color: colorInt("Solid background when type is color.", 0xf4f5f7),
  background_url: z.string().max(512).default("").describe("Background image URL when type is url."),
  show_server_icon: z.boolean().default(true).describe("Show the server icon on the page."),
  show_server_name: z.boolean().default(true).describe("Show the server name on the page."),
  show_member_count: z.boolean().default(true).describe("Show the member count on the page."),
  show_user_avatar: z.boolean().default(true).describe("Show the signed-in user's avatar."),
  success_title: z.string().max(200).default("You're verified").describe("Title after a successful verify."),
  success_body: z
    .string()
    .max(2000)
    .default("You can close this tab and head back to Discord.")
    .describe("Body after a successful verify."),
  already_verified_title: z.string().max(200).default("Already verified").describe("Title when already verified."),
  already_verified_body: z
    .string()
    .max(2000)
    .default("You're already verified in this server.")
    .describe("Body when already verified."),
  not_a_member_title: z.string().max(200).default("Join the server first").describe("Title when the user is not in the guild."),
  not_a_member_body: z
    .string()
    .max(2000)
    .default("You need to be a member of this server to verify.")
    .describe("Body when the user is not in the guild."),
  disabled_title: z.string().max(200).default("Verification is off").describe("Title when Passport is disabled."),
  disabled_body: z
    .string()
    .max(2000)
    .default("This server isn't using Passport right now.")
    .describe("Body when Passport is disabled."),
});

export const zPassportConfig = z.strictObject({
  channel_id: channelId("Channel where join pings and the persistent Verify panel are posted."),
  unverified_role_id: roleId("Role applied when a member joins, until they verify."),
  grant_role_ids: snowflakeList("Roles granted after a successful verification."),
  remove_role_ids: snowflakeList("Extra roles removed after a successful verification."),
  strip_roles_until_verified: z
    .boolean()
    .default(false)
    .describe("Strip every other role on join until they verify. Use with care."),
  nickname: z
    .string()
    .max(32)
    .default("")
    .describe("Optional nickname template applied on success. Supports placeholders."),
  ping: zPassportPingConfig.default({}),
  panel: zPassportPanelConfig.default({}),
  page: zPassportPageConfig.default({}),
  remember_verifications: z
    .boolean()
    .default(true)
    .describe("Skip the gate when a previously verified member rejoins."),
  min_account_age_seconds: z
    .number()
    .int()
    .min(0)
    .max(31_536_000)
    .default(0)
    .describe("Minimum Discord account age in seconds (0 = off)."),
  bypass_role_ids: snowflakeList("Members with any of these roles skip Passport."),
  timeout_action: z
    .enum(["none", "kick"])
    .default("none")
    .describe("What to do if they never finish verification."),
  timeout_seconds: z
    .number()
    .int()
    .min(0)
    .max(2_592_000)
    .default(0)
    .describe("Seconds to wait before the timeout action (0 = never)."),
  timeout_dm: z
    .string()
    .max(2000)
    .default("")
    .describe("Optional DM sent before a timeout kick. Supports placeholders."),
  can_panel: boolPerm("post a persistent Passport panel"),
  can_force: boolPerm("force-verify a member"),
  can_revoke: boolPerm("revoke a member's verification"),
  can_test: boolPerm("send a test Passport ping"),
});

export const zPassportPluginSection = zPluginSection(zPassportConfig.shape);

export type PassportPingConfig = z.infer<typeof zPassportPingConfig>;
export type PassportPanelConfig = z.infer<typeof zPassportPanelConfig>;
export type PassportPageConfig = z.infer<typeof zPassportPageConfig>;
export type PassportConfig = z.infer<typeof zPassportConfig>;
