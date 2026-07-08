import type { ConfigOverride } from "../../core/types.js";

export const censorDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_list: true,
      can_add: true,
      can_remove: true,
    },
  },
];
