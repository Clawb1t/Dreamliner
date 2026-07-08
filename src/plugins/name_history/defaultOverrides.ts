import type { ConfigOverride } from "../../core/types.js";

export const nameHistoryDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_view: true,
      can_search: true,
    },
  },
];
