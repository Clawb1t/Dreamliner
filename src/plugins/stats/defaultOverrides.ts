import type { ConfigOverride } from "../../core/types.js";

export const statsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_server: true,
      can_user: true,
      can_channel: true,
    },
  },
];
