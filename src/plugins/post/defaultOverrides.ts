import type { ConfigOverride } from "../../core/types.js";

export const postDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_list: true,
      can_delete: true,
    },
  },
];
