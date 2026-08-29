import type { ConfigOverride } from "../../core/types.js";

export const socialDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_manage: true,
      can_view: true,
    },
  },
];
