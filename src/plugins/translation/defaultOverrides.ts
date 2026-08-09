import type { ConfigOverride } from "../../core/types.js";

export const translationDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_translate: true,
    },
  },
];
