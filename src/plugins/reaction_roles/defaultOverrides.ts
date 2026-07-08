import type { ConfigOverride } from "../../core/types.js";

export const reactionRolesDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_delete: true,
    },
  },
];
