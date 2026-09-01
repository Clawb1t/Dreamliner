import type { ConfigOverride } from "../../core/types.js";

export const economyDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=0",
    config: {
      can_balance: true,
      can_daily: true,
      can_stock_trade: true,
      can_exchange: true,
      can_view: true,
      can_buy_pack: true,
      can_give: true,
      can_sell: true,
    },
  },
  {
    level: ">=50",
    config: {
      can_admin_manage: true,
    },
  },
];
