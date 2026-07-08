import type { ConfigOverride } from "../../core/types.js";

export const automodDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_status: true,
      can_test: true,
    },
  },
];
