import type { ConfigOverride } from "../../core/types.js";

export const economyDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=0",
    config: {
      can_balance: true,
      can_daily: true,
    },
  },
  {
    level: ">=50",
    config: {
      can_admin_manage: true,
    },
  },
];
