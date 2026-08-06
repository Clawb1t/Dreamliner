import type { ConfigOverride } from "../../core/types.js";

export const dreamCommandsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_edit: true,
      can_remove: true,
      can_list: true,
    },
  },
];
