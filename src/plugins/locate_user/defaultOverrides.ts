import type { ConfigOverride } from "../../core/types.js";

export const locateUserDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_locate: true,
    },
  },
];
