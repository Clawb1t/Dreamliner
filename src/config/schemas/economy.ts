import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

const snowflakeList = (help: string) =>
  z
    .array(z.string())
    .default([])
    .describe(help);

const nonNegInt = (help: string, fallback: number, max = 1_000_000_000) =>
  z
    .number()
    .int()
    .min(0)
    .max(max)
    .default(fallback)
    .describe(help);

export const zEconomyModulesConfig = z.strictObject({
  banking: z.boolean().default(true).describe("Enable bank deposit/withdraw."),
  rewards: z.boolean().default(true).describe("Enable daily/weekly/monthly claims."),
  work: z.boolean().default(true).describe("Enable /economy rewards work."),
  jobs: z.boolean().default(true).describe("Enable career jobs."),
  shop: z.boolean().default(true).describe("Enable shops and inventory."),
  pets: z.boolean().default(true).describe("Enable pets."),
  crafting: z.boolean().default(true).describe("Enable crafting."),
  quests: z.boolean().default(true).describe("Enable quests and achievements."),
  trading: z.boolean().default(true).describe("Enable direct player trades."),
  marketplace: z.boolean().default(true).describe("Enable fixed-price marketplace."),
  auctions: z.boolean().default(true).describe("Enable auctions."),
  seasons: z.boolean().default(true).describe("Enable seasons."),
  activity_rewards: z.boolean().default(false).describe("Pay for messages/voice activity."),
});

export const zEconomyCurrencyDisplayConfig = z.strictObject({
  name: z.string().max(32).default("Coins").describe("Primary currency display name."),
  name_singular: z.string().max(32).default("Coin").describe("Singular form of the primary currency."),
  symbol: z
    .string()
    .max(64)
    .default("🪙")
    .describe("Primary currency emoji or symbol. Custom server emojis (<:coin:123>) work too."),
  secondary_name: z.string().max(32).default("Gems").describe("Secondary currency display name."),
  secondary_name_singular: z.string().max(32).default("Gem").describe("Singular secondary currency."),
  secondary_symbol: z
    .string()
    .max(64)
    .default("💎")
    .describe("Secondary currency emoji or symbol. Custom server emojis (<:gem:123>) work too."),
});

export const zEconomyBankConfig = z.strictObject({
  enabled: z.boolean().default(true).describe("Allow bank storage."),
  deposit_fee_bps: nonNegInt("Deposit fee in basis points (100 = 1%).", 0, 10_000),
  withdraw_fee_bps: nonNegInt("Withdraw fee in basis points (100 = 1%).", 0, 10_000),
  interest_bps_daily: nonNegInt("Daily bank interest in basis points.", 0, 1_000),
  max_balance: nonNegInt("Maximum bank balance per currency (0 = unlimited).", 0),
});

export const zEconomyRewardsConfig = z.strictObject({
  daily_amount: nonNegInt("Base daily claim amount (primary currency).", 250),
  daily_streak_bonus: nonNegInt("Extra primary currency per consecutive daily streak day.", 25),
  daily_streak_cap: nonNegInt("Maximum streak days that grant bonus.", 30),
  daily_streak_grace_hours: nonNegInt("Hours after reset where a late claim keeps the streak.", 6, 168),
  weekly_amount: nonNegInt("Weekly claim amount (primary currency).", 1_500),
  monthly_amount: nonNegInt("Monthly claim amount (primary currency).", 5_000),
  work_min: nonNegInt("Minimum work payout.", 50),
  work_max: nonNegInt("Maximum work payout.", 200),
  work_cooldown_seconds: nonNegInt("Work cooldown in seconds.", 3_600, 604_800),
  timezone: z
    .string()
    .max(64)
    .default("UTC")
    .describe("IANA timezone used for daily/weekly/monthly resets."),
});

export const zEconomyTransferConfig = z.strictObject({
  enabled: z.boolean().default(true).describe("Allow member-to-member payments."),
  tax_bps: nonNegInt("Transfer tax in basis points (100 = 1%).", 0, 10_000),
  min_amount: nonNegInt("Minimum transfer amount.", 1),
  max_amount: nonNegInt("Maximum transfer amount (0 = unlimited).", 0),
  confirm_above: nonNegInt("Require confirmation when transferring at or above this amount.", 10_000),
});

export const zEconomyInventoryConfig = z.strictObject({
  max_slots: nonNegInt("Maximum distinct inventory stacks per member.", 100, 1_000),
  max_stack: nonNegInt("Maximum quantity per stack.", 9_999, 1_000_000),
  allow_gift: z.boolean().default(true).describe("Allow gifting inventory items."),
});

export const zEconomyMarketConfig = z.strictObject({
  listing_fee_bps: nonNegInt("Marketplace listing fee in basis points.", 0, 10_000),
  sale_tax_bps: nonNegInt("Marketplace sale tax in basis points.", 500, 10_000),
  max_listings_per_user: nonNegInt("Max active marketplace listings per member.", 10, 100),
  auction_min_duration_seconds: nonNegInt("Minimum auction duration seconds.", 3_600, 2_592_000),
  auction_max_duration_seconds: nonNegInt("Maximum auction duration seconds.", 604_800, 2_592_000),
  auction_anti_snipe_seconds: nonNegInt("Extend auction by this many seconds on late bids.", 120, 3_600),
  auction_min_increment_bps: nonNegInt("Minimum bid increment over current bid (bps).", 500, 10_000),
  trade_timeout_seconds: nonNegInt("Direct trade session timeout seconds.", 900, 86_400),
});

export const zEconomyActivityConfig = z.strictObject({
  message_amount: nonNegInt("Primary currency per rewarded message.", 1, 1_000),
  message_cooldown_seconds: nonNegInt("Cooldown between message rewards for a user.", 60, 86_400),
  message_min_length: nonNegInt("Minimum message length to earn.", 5, 2_000),
  voice_amount_per_minute: nonNegInt("Primary currency per rewarded voice minute.", 2, 1_000),
  voice_afk_ignored: z.boolean().default(true).describe("Ignore AFK voice channel for rewards."),
  daily_mint_cap: nonNegInt("Max primary currency a user can mint from activity per day (0 = unlimited).", 500),
  min_account_age_days: nonNegInt("Minimum Discord account age in days to earn activity rewards.", 3, 365),
  min_member_age_days: nonNegInt("Minimum server membership age in days to earn activity rewards.", 0, 365),
  allowed_channel_ids: snowflakeList("If non-empty, only these channels grant activity rewards."),
  denied_channel_ids: snowflakeList("Channels that never grant activity rewards."),
  denied_role_ids: snowflakeList("Roles that never grant activity rewards."),
});

export const zEconomyPetsConfig = z.strictObject({
  max_pets: nonNegInt("Maximum pets a member may own.", 5, 50),
  hunger_decay_per_hour: nonNegInt("Hunger points lost per hour (lazy).", 2, 100),
  energy_decay_per_hour: nonNegInt("Energy points lost per hour (lazy).", 3, 100),
  feed_cost: nonNegInt("Primary currency cost to feed (if no food item).", 25),
  play_energy_cost: nonNegInt("Energy spent when playing.", 10, 100),
  battles_enabled: z.boolean().default(true).describe("Allow non-wager pet battles."),
});

export const zEconomyProgressionConfig = z.strictObject({
  xp_per_work: nonNegInt("Economy XP granted on work.", 10),
  xp_per_daily: nonNegInt("Economy XP granted on daily claim.", 15),
  xp_per_purchase: nonNegInt("Economy XP granted on shop purchase.", 5),
  level_curve_base: nonNegInt("XP required for level 2; grows by curve factor each level.", 100),
  level_curve_factor: z
    .number()
    .min(1)
    .max(3)
    .default(1.15)
    .describe("Multiplies XP requirement each level."),
});

export const zEconomyPrivacyConfig = z.strictObject({
  hide_balances_by_default: z
    .boolean()
    .default(false)
    .describe("When true, other members cannot inspect balances unless opted in."),
  leaderboard_public: z.boolean().default(true).describe("Allow public economy leaderboards."),
});

export const zEconomyConfig = z.strictObject({
  modules: zEconomyModulesConfig.default({}),
  currency: zEconomyCurrencyDisplayConfig.default({}),
  bank: zEconomyBankConfig.default({}),
  rewards: zEconomyRewardsConfig.default({}),
  transfers: zEconomyTransferConfig.default({}),
  inventory: zEconomyInventoryConfig.default({}),
  market: zEconomyMarketConfig.default({}),
  activity: zEconomyActivityConfig.default({}),
  pets: zEconomyPetsConfig.default({}),
  progression: zEconomyProgressionConfig.default({}),
  privacy: zEconomyPrivacyConfig.default({}),
  log_channel_id: channelId("Optional dedicated economy audit channel."),
  announcement_channel_id: channelId("Optional channel for season/auction announcements."),
  paused: z
    .boolean()
    .default(false)
    .describe("Emergency pause — blocks earning, spending, trading, and markets."),
  booster_multiplier_bps: nonNegInt(
    "Extra reward multiplier for Discord Nitro boosters in basis points (1000 = +10%).",
    0,
    10_000,
  ),
  multiplier_role_ids: snowflakeList("Roles that receive the role reward multiplier."),
  role_multiplier_bps: nonNegInt(
    "Extra reward multiplier for multiplier_role_ids in basis points.",
    0,
    10_000,
  ),
  starting_balance: nonNegInt("Primary currency granted when a member first touches the economy.", 100),
  starting_secondary: nonNegInt("Secondary currency granted on first touch.", 0),

  can_balance: boolPerm("view balances"),
  can_bank: boolPerm("use the bank"),
  can_history: boolPerm("view transaction history"),
  can_profile: boolPerm("view economy profiles"),
  can_daily: boolPerm("claim daily rewards"),
  can_weekly: boolPerm("claim weekly rewards"),
  can_monthly: boolPerm("claim monthly rewards"),
  can_work: boolPerm("use work / jobs"),
  can_pay: boolPerm("pay other members"),
  can_gift: boolPerm("gift items"),
  can_inspect: boolPerm("inspect other members' public economy info"),
  can_shop: boolPerm("browse and buy from shops"),
  can_inventory: boolPerm("manage inventory"),
  can_jobs: boolPerm("use jobs"),
  can_pets: boolPerm("use pets"),
  can_craft: boolPerm("craft items"),
  can_quests: boolPerm("view and claim quests"),
  can_trade: boolPerm("use direct trades"),
  can_market: boolPerm("use the marketplace"),
  can_auction: boolPerm("use auctions"),
  can_leaderboard: boolPerm("view economy leaderboards"),
  can_season: boolPerm("view season info"),
  can_admin_adjust: boolPerm("adjust balances as staff"),
  can_admin_freeze: boolPerm("freeze and unfreeze accounts"),
  can_admin_inspect: boolPerm("inspect any account and ledger"),
  can_admin_wipe: boolPerm("wipe accounts or reset economy data"),
  can_admin_pause: boolPerm("pause and resume the economy"),
  can_admin_catalog: boolPerm("manage shops, items, jobs, pets, recipes, and quests"),
  can_admin_market: boolPerm("moderate markets, trades, and auctions"),
  can_admin_export: boolPerm("export and import economy data"),
});

export const zEconomyPluginSection = zPluginSection(zEconomyConfig.shape);

export type EconomyConfig = z.infer<typeof zEconomyConfig>;
