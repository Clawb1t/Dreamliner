import type { ConfigOverride } from "../../core/types.js";

export const suggestionsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=0",
    config: {
      can_suggest: true,
      can_vote: true,
      can_follow: true,
      can_info: true,
      can_top: true,
      can_approve: false,
      can_deny: false,
      can_mark: false,
      can_comment: false,
      can_delete: false,
      can_block: false,
      can_manage: false,
    },
  },
  {
    level: ">=50",
    config: {
      can_approve: true,
      can_deny: true,
      can_mark: true,
      can_comment: true,
      can_delete: true,
      can_block: true,
      can_manage: true,
    },
  },
];
