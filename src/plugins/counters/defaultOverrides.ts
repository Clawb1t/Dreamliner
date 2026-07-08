import type { ConfigOverride } from "../../core/types.js";

export const countersDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_set: true,
      can_delete: true,
    },
  },
];
