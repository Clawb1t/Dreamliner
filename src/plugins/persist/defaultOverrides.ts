import type { ConfigOverride } from "../../core/types.js";

export const persistDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_add: true,
      can_remove: true,
      can_list: true,
    },
  },
];
