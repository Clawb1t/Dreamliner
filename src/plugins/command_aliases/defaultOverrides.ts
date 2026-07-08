import type { ConfigOverride } from "../../core/types.js";

export const commandAliasesDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_list: true,
      can_run: true,
    },
  },
  {
    level: ">=100",
    config: {
      can_create: true,
      can_delete: true,
    },
  },
];
