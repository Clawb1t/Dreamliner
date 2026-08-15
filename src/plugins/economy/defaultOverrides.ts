import type { ConfigOverride } from "../../core/types.js";

export const economyDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=0",
    config: {
      can_balance: true,
      can_bank: true,
      can_history: true,
      can_profile: true,
      can_daily: true,
      can_weekly: true,
      can_monthly: true,
      can_work: true,
      can_pay: true,
      can_gift: true,
      can_inspect: true,
      can_shop: true,
      can_inventory: true,
      can_jobs: true,
      can_pets: true,
      can_craft: true,
      can_quests: true,
      can_trade: true,
      can_market: true,
      can_auction: true,
      can_leaderboard: true,
      can_season: true,
    },
  },
  {
    level: ">=50",
    config: {
      can_admin_adjust: true,
      can_admin_freeze: true,
      can_admin_inspect: true,
      can_admin_wipe: false,
      can_admin_pause: true,
      can_admin_catalog: true,
      can_admin_market: true,
      can_admin_export: true,
    },
  },
  {
    level: ">=100",
    config: {
      can_admin_wipe: true,
    },
  },
];
