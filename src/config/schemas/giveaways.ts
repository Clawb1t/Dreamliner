import { z } from "zod";
import { boolPerm, channelId, roleId } from "../schemaHelp.js";
import { TICKET_BUTTON_STYLES } from "./tickets.js";
import { zPersistEmbedConfig } from "./persist.js";
import { zPluginSection } from "./pluginSection.js";

/** Guild-wide defaults a new giveaway is pre-filled with from the dashboard. Giveaway instances
 *  themselves are DB rows (`giveaways` table), not config; there's no per-giveaway config here. */
export const zGiveawaysConfig = z.strictObject({
  log_channel_id: channelId("Channel for giveaway start/end/reroll event logs."),
  default_entry_method: z
    .enum(["button", "reaction"])
    .default("button")
    .describe("Default entry mechanism for new giveaways when not overridden per-giveaway."),
  default_reaction_emoji: z
    .string()
    .max(128)
    .default("<:icons_gift:1544417552627802212>")
    .describe("Default reaction emoji for reaction-entry giveaways."),
  default_button_label: z.string().max(80).default("Enter").describe("Default entry button label."),
  default_button_emoji: z
    .string()
    .max(128)
    .default("<:icons_gift:1544417552627802212>")
    .describe("Default entry button emoji."),
  default_button_style: z.enum(TICKET_BUTTON_STYLES).default("primary").describe("Default entry button color."),
  default_winner_count: z.number().int().min(1).default(1).describe("Default number of winners for a new giveaway."),
  default_embed: zPersistEmbedConfig.default({}).describe("Default embed a new giveaway starts from."),
  default_dm_winner: z.boolean().default(true).describe("Default: DM the winner(s) when a giveaway ends."),
  default_dm_non_winners: z.boolean().default(false).describe("Default: DM entrants who didn't win when a giveaway ends."),
  default_claim_window_minutes: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Default minutes a winner has to claim before an automatic reroll. 0 disables the claim window."),
  default_require_role_mode: z.enum(["any", "all"]).default("any").describe("Default match mode for required roles."),
  default_booster_bonus_weight: z
    .number()
    .min(0)
    .default(0)
    .describe("Default extra entry weight granted to server boosters."),
  default_entry_cost: z
    .number()
    .min(0)
    .default(0)
    .describe("Default server currency cost to enter a new giveaway. 0 disables."),
  default_win_bonus: z
    .number()
    .min(0)
    .default(0)
    .describe("Default server currency awarded to a winner when they claim their prize. 0 disables."),
  ping_role_id: roleId("Default role pinged when a giveaway starts, if the giveaway has no override."),
  can_create_via_dashboard: boolPerm("create giveaways from the dashboard"),
  can_reroll: boolPerm("manually reroll a giveaway's winner(s)"),
  can_end: boolPerm("end a giveaway immediately"),
  can_pause: boolPerm("pause or resume a giveaway"),
  can_cancel: boolPerm("cancel or delete a giveaway"),
  can_view_all: boolPerm("view all giveaways and entrants in the dashboard queue and /giveaway list"),
});

export type GiveawaysConfig = z.infer<typeof zGiveawaysConfig>;

export const zGiveawaysPluginSection = zPluginSection(zGiveawaysConfig.shape, false);

export type GiveawaysPluginSection = z.infer<typeof zGiveawaysPluginSection>;
