import type { ConfigOverride } from "../../core/types.js";

export const scamProtectDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_setup: true,
      can_status: true,
    },
  },
];
