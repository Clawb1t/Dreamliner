import type { ConfigOverride } from "../../core/types.js";

export const welcomeMessageDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_set: true,
      can_test: true,
      can_disable: true,
    },
  },
];
