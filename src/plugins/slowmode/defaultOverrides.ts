import type { ConfigOverride } from "../../core/types.js";

export const slowmodeDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_set: true,
      can_clear: true,
      can_manage_rules: true,
      can_configure: true,
    },
  },
];
