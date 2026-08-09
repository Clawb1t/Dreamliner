import type { ConfigOverride } from "../../core/types.js";

export const reviewsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=0",
    config: {
      can_review: true,
      can_list: false,
      can_delete: false,
      can_manage: false,
    },
  },
  {
    level: ">=50",
    config: {
      can_list: true,
      can_delete: true,
      can_manage: true,
    },
  },
];
