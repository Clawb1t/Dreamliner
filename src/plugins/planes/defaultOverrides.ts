import type { ConfigOverride } from "../../core/types.js";

export const planesDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=0",
    config: {
      can_view: true,
      can_buy_pack: true,
      can_give: true,
      can_sell: true,
    },
  },
];
