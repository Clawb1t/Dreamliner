import type { ConfigOverride } from "../../core/types.js";

export const adminDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_lockdown: true,
      can_unlock: true,
    },
  },
];
