import type { ConfigOverride } from "../../core/types.js";

export const ticketsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=25",
    config: {
      can_claim: true,
      can_close: true,
      can_reopen: true,
      can_add_remove_members: true,
    },
  },
  {
    level: ">=50",
    config: {
      can_close_others: true,
    },
  },
  {
    level: ">=75",
    config: {
      can_manage_panels: true,
      can_view_all: true,
      can_blacklist: true,
    },
  },
  {
    level: ">=100",
    config: {
      can_delete: true,
    },
  },
];
