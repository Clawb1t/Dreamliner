import type { ConfigOverride } from "../../core/types.js";

export const pingableRolesDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_enable: true,
      can_disable: true,
    },
  },
];
