import type { ConfigOverride } from "../../core/types.js";

export const customEventsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_list: true,
    },
  },
  {
    level: ">=100",
    config: {
      can_delete: true,
    },
  },
];
