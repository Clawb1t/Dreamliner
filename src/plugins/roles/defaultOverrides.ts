import type { ConfigOverride } from "../../core/types.js";

export const rolesDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_give: true,
      can_remove: true,
      can_list: true,
    },
  },
];
