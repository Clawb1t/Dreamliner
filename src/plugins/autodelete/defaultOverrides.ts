import type { ConfigOverride } from "../../core/types.js";

export const autodeleteDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_set: true,
      can_clear: true,
    },
  },
];
