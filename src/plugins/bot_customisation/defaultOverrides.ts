import type { ConfigOverride } from "../../core/types.js";

export const botCustomisationDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_avatar: true,
      can_nickname: true,
    },
  },
];
