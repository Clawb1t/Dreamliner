import type { ConfigOverride } from "../../core/types.js";

export const passportDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_panel: true,
      can_force: true,
      can_revoke: true,
      can_test: true,
    },
  },
];
