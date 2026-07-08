import type { ConfigOverride } from "../../core/types.js";

export const tagsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_edit: true,
      can_delete: true,
      can_list: true,
      can_show: true,
    },
  },
];
